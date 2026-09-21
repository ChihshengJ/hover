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
 * Usage: bun scripts/package.mjs [--targets chrome,firefox] [--no-lint]
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { pruneJunk, JUNK } from "./clean_junk.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const targets = value("--targets", "chrome,firefox").split(",");
const lint = !flag("--no-lint");
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

if (failed) process.exit(1);
