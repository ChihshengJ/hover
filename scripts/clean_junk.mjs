/**
 * Remove macOS/Windows filesystem cruft from a build output directory.
 *
 * Finder writes .DS_Store into any folder it has displayed, and `public/`
 * carries those into dist/ via Vite's publicDir copy. Chrome tolerates them,
 * but AMO's validator flags every hidden file in a submitted XPI, so strip
 * them at the source instead of only at zip time.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Names/patterns that must never reach a store package. */
export const JUNK = [
  ".DS_Store",
  "__MACOSX",
  "Thumbs.db",
  "desktop.ini",
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
];

const isJunk = (name) =>
  JUNK.includes(name) || name.startsWith("._") || name.endsWith(".orig");

/** Delete junk files under `dir`, returning the paths removed. */
export function pruneJunk(dir) {
  const removed = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(current, name);
      if (isJunk(name)) {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
        continue;
      }
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(dir);
  return removed;
}
