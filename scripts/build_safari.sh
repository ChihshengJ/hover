#!/usr/bin/env bash
# Convert dist/safari into a Safari app-extension Xcode project and build it
# headlessly. No manual Xcode interaction needed.
#
#   bun run build:safari        # vite build + this script
#   DEVELOPMENT_TEAM=XXXXXXXXXX bun run build:safari   # pin a signing team
#
# The generated project (safari/) is disposable — it is regenerated from
# dist/safari on every run and is gitignored.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist/safari"
PROJ_ROOT="$ROOT/safari"
APP_NAME="Hover PDF"
BUNDLE_ID="${BUNDLE_ID:-com.chihshengj.hoverpdf}"

if [[ ! -f "$DIST/manifest.json" ]]; then
  echo "error: $DIST not built — run 'bun run build:safari'" >&2
  exit 1
fi

# --- 1. Regenerate the Xcode project from the web extension ----------------
xcrun safari-web-extension-converter "$DIST" \
  --project-location "$PROJ_ROOT" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --no-open \
  --no-prompt \
  --force

XCODEPROJ="$PROJ_ROOT/$APP_NAME/$APP_NAME.xcodeproj"
if [[ ! -d "$XCODEPROJ" ]]; then
  echo "error: expected Xcode project at $XCODEPROJ" >&2
  find "$PROJ_ROOT" -maxdepth 2 -name "*.xcodeproj" >&2
  exit 1
fi

# Xcode 27's converter writes project.xcproj, a JSON-style file with
# "KEY": "value", entries; earlier ones write project.pbxproj with
# KEY = value; entries. The patches below accept either.
PBXPROJ="$XCODEPROJ/project.pbxproj"
[[ -f "$PBXPROJ" ]] || PBXPROJ="$XCODEPROJ/project.xcproj"
if [[ ! -f "$PBXPROJ" ]]; then
  echo "error: no project.pbxproj or project.xcproj in $XCODEPROJ" >&2
  ls "$XCODEPROJ" >&2
  exit 1
fi

# --- 1b. Normalize bundle identifiers and deployment target ----------------
# The converter derives the app target's identifier from the app name and
# only applies --bundle-identifier to the appex, which makes the embedded
# binary's id not prefixed by the parent's and fails ValidateEmbeddedBinary.
# Force: app = $BUNDLE_ID, extension = $BUNDLE_ID.Extension.
MACOS_MIN="${MACOS_MIN:-15.0}"
BUNDLE_ID="$BUNDLE_ID" MACOS_MIN="$MACOS_MIN" python3 - "$PBXPROJ" <<'EOF'
import os, re, sys
path = sys.argv[1]
bundle_id, mn = os.environ["BUNDLE_ID"], os.environ["MACOS_MIN"]
src = open(path).read()

def setting(key):
    # KEY = value;  or  "KEY": "value",  — optionally KEY[config=Debug]
    return re.compile(
        r'(\b%s(?:\[[^\]]*\])?"?\s*[=:]\s*)("?)([^";,\n]+)\2' % key
    )

def fix_bundle_id(m):
    suffix = ".Extension" if m.group(3).endswith(".Extension") else ""
    return f'{m.group(1)}"{bundle_id}{suffix}"'

src, ids = setting("PRODUCT_BUNDLE_IDENTIFIER").subn(fix_bundle_id, src)
src, mins = setting("MACOSX_DEPLOYMENT_TARGET").subn(
    lambda m: f'{m.group(1)}"{mn}"', src
)
if not ids:
    sys.exit(f"error: no PRODUCT_BUNDLE_IDENTIFIER found in {path}")
open(path, "w").write(src)
print(f"[build_safari] Normalized {ids} bundle ids to {bundle_id}(.Extension)")
print(f"[build_safari] Deployment target -> macOS {mn} ({mins} settings)")
EOF

# --- 2. Pick a signing team -------------------------------------------------
# OU of the first Apple Development certificate in the keychain, unless
# DEVELOPMENT_TEAM is set.
if [[ -z "${DEVELOPMENT_TEAM:-}" ]]; then
  DEVELOPMENT_TEAM="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p')"
fi
if [[ -z "$DEVELOPMENT_TEAM" ]]; then
  echo "warning: no Apple Development certificate found — building unsigned." >&2
  echo "         You'll need Safari → Develop → Allow Unsigned Extensions." >&2
fi

# --- 3. Build ---------------------------------------------------------------
SIGN_ARGS=()
if [[ -n "$DEVELOPMENT_TEAM" ]]; then
  SIGN_ARGS=(DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates)
else
  SIGN_ARGS=(CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO)
fi

LOG="$PROJ_ROOT/xcodebuild.log"
if ! xcodebuild \
  -project "$XCODEPROJ" \
  -scheme "$APP_NAME" \
  -configuration Debug \
  -derivedDataPath "$PROJ_ROOT/build" \
  "${SIGN_ARGS[@]}" \
  build > "$LOG" 2>&1; then
  echo "error: xcodebuild failed — relevant output:" >&2
  grep -E "error:|BUILD FAILED" "$LOG" >&2 || tail -20 "$LOG" >&2
  exit 1
fi
grep -E "BUILD SUCCEEDED" "$LOG" || true

APP="$PROJ_ROOT/build/Build/Products/Debug/$APP_NAME.app"
if [[ ! -d "$APP" ]]; then
  echo "error: build did not produce $APP" >&2
  exit 1
fi

echo
echo "Safari app built: $APP"
echo "First time (or after Safari forgets it): open it once, then enable the"
echo "extension in Safari → Settings → Extensions. Subsequent rebuilds only"
echo "need the extension reloaded (Safari picks up the new build on relaunch"
echo "of the app)."
