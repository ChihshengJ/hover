/**
 * Zip the chrome and firefox builds into releases/, named by the
 * manifest version. (Safari distribution goes through Xcode archive
 * instead — see scripts/build_safari.sh for local dev builds.)
 *
 * Two things make a store-ready archive different from dragging dist/ onto
 * Finder's "Compress":
 *
 *   1. manifest.json must sit at the archive root. Compressing the *folder*
 *      nests everything under `chrome/`, and both stores reject that. So zip
 *      from inside the directory — the equivalent of selecting all the files
 *      and compressing the selection.
 *   2. No .DS_Store, no __MACOSX/._* resource forks. AMO's validator flags
 *      hidden files, and Finder/ditto add the forks unconditionally. The zip
 *      CLI doesn't, and we prune the source tree first as well.
 *
 * Firefox review additionally requires the unminified source, since the
 * uploaded build is minified — see packageSource() below.
 *
 * Usage: bun scripts/package.mjs [--targets chrome,firefox] [--no-lint] [--no-src]
 */
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneJunk, JUNK } from "./clean_junk.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const targets = value("--targets", "chrome,firefox").split(",");
const lint = !flag("--no-lint");
const src = !flag("--no-src");
const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
mkdirSync("releases", { recursive: true });

// Passed to `zip -x`; belt and braces on top of pruneJunk, since the tree can
// pick up a .DS_Store between the build and this script running.
const excludes = [...JUNK.map((n) => `*/${n}`), ...JUNK, "._*", "*/._*"];

const mb = (path) => (statSync(path).size / 1024 ** 2).toFixed(1);

let failed = false;

for (const target of targets) {
  const dir = `dist/${target}`;
  if (!existsSync(`${dir}/manifest.json`)) {
    console.error(
      `Skipping ${target}: ${dir} not built (run bun run build:${target})`,
    );
    failed = true;
    continue;
  }

  const removed = pruneJunk(dir);
  if (removed.length) {
    console.log(`  pruned ${removed.length} junk file(s) from ${dir}/`);
  }

  if (target === "firefox" && lint) {
    // AMO runs this same validator on upload; catching errors here beats
    // finding them after the submission form has eaten the archive.
    try {
      execFileSync("bunx", ["web-ext", "lint", "--source-dir", dir], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      console.log("  web-ext lint: 0 errors");
    } catch (err) {
      console.error(`  web-ext lint FAILED for ${dir}:`);
      console.error(String(err.stderr || err.message));
      failed = true;
      continue;
    }
  }

  const zip = `releases/hover-${target}-${version}.zip`;
  const exclude = excludes.map((p) => `'${p}'`).join(" ");
  // `-X` drops extra file attributes (uid/gid, Finder metadata); `.` zips the
  // directory *contents*, so manifest.json lands at the archive root.
  execSync(`rm -f "../../${zip}"; zip -rqX "../../${zip}" . -x ${exclude}`, {
    cwd: dir,
    stdio: "inherit",
    shell: "/bin/bash",
  });

  const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const junk = entries.filter((e) =>
    e.split("/").some((part) => JUNK.includes(part) || part.startsWith("._")),
  );
  if (junk.length) {
    console.error(`  ${zip} still contains junk entries:`, junk);
    failed = true;
    continue;
  }
  if (!entries.includes("manifest.json")) {
    console.error(`  ${zip} has no manifest.json at its root — not loadable`);
    failed = true;
    continue;
  }

  console.log(`Packaged ${zip} (${entries.length} entries, ${mb(zip)} MB)`);
}

/**
 * Zip the unminified sources for AMO review, which requires them whenever the
 * uploaded build is minified (ours is — `build.minify` is on).
 *
 * The file list comes from the *working tree* rather than `git archive HEAD`
 * on purpose: the reviewer has to be able to reproduce the exact artifact we
 * uploaded, and dist/ is built from the working tree, which is routinely ahead
 * of the last commit. Ignored paths are skipped via --exclude-standard, so
 * node_modules/ and dist/ stay out. Three tracked paths are dropped as pure
 * bloat, none of which the build reads: `marketing/` and `assets/` are
 * screenshots and demo GIFs used by README.md and the store listings (the
 * images the extension actually ships live in `public/assets/`), and
 * `releases/` holds two legacy zips committed before it was gitignored.
 */
function packageSource(version) {
  const tracked = execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (f) =>
        !f.startsWith("marketing/") &&
        !f.startsWith("assets/") &&
        !f.startsWith("releases/"),
    )
    .filter((f) => !JUNK.includes(f.split("/").pop()));

  const zip = `releases/hover-src-${version}.zip`;
  const tmp = mkdtempSync(join(tmpdir(), "hover-src-"));
  try {
    const listFile = join(tmp, "files.txt");
    writeFileSync(listFile, tracked.join("\n") + "\n");
    execSync(`rm -f "${zip}"; zip -qX "${zip}" -@ < "${listFile}"`, {
      stdio: "inherit",
      shell: "/bin/bash",
    });

    // AMO wants build instructions alongside the source. Generate them so the
    // recorded toolchain versions can't drift from the machine that built.
    const buildDoc = join(tmp, "BUILD.md");
    writeFileSync(buildDoc, buildInstructions(version));
    execFileSync("zip", ["-qXj", zip, buildDoc]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const required of ["package.json", "bun.lock", "vite.config.js", "BUILD.md"]) {
    if (!entries.includes(required)) {
      console.error(`  ${zip} is missing ${required} — reviewers can't rebuild`);
      return false;
    }
  }
  console.log(`Packaged ${zip} (${entries.length} entries, ${mb(zip)} MB)`);
  return true;
}

function buildInstructions(version) {
  const bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
  return `# Build instructions — Hover PDF ${version} (Firefox)

Produces a \`dist/firefox/\` tree identical to the contents of the uploaded
\`hover-firefox-${version}.zip\`.

## Environment

- bun ${bun} (https://bun.sh) — used as both package manager and task runner
- No other toolchain is required; bun runs the TypeScript and Vite build.
- Built and verified on macOS; Linux works the same way.

## Steps

\`\`\`bash
bun install --frozen-lockfile
STORE_BUILD=1 bun run build:firefox
\`\`\`

The output is \`dist/firefox/\`.

## Notes for the reviewer

- \`STORE_BUILD=1\` pins the PDF engine to the locally bundled WebAssembly
  binary and strips the CDN URL that @embedpdf/pdfium would otherwise fall
  back to, so the build loads no remote code.
- \`public/pdfium.wasm\` is absent from this archive by design. It is copied
  verbatim from \`node_modules/@embedpdf/pdfium/dist/pdfium.wasm\` during
  \`bun install\` + build by the \`copy-wasm-to-public\` plugin in
  \`vite.config.js\`; it is a third-party binary, not our source.
- The screenshots and demo GIFs referenced by README.md are omitted; they are
  listing media, not build inputs, so some image links in README.md will not
  resolve. The images the extension itself ships are under \`public/assets/\`.
- \`manifest.json\` in this archive is the Chrome base manifest. The Firefox
  manifest is produced at build time by deep-merging \`manifests/firefox.json\`
  over it (see the \`emit-target-manifest\` plugin in \`vite.config.js\`).
- The build is minified (\`build.minify\` in \`vite.config.js\`). No other
  transformation, obfuscation, or code generation is applied.
`;
}

if (src && targets.includes("firefox")) {
  if (!packageSource(version)) failed = true;
}

if (failed) process.exit(1);
