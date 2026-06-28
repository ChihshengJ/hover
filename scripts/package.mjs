/**
 * Zip the chrome and firefox builds into releases/, named by the
 * manifest version. (Safari distribution goes through Xcode archive
 * instead — see scripts/build_safari.sh for local dev builds.)
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("manifest.json", "utf8")).version;
mkdirSync("releases", { recursive: true });

for (const target of ["chrome", "firefox"]) {
  const dir = `dist/${target}`;
  if (!existsSync(`${dir}/manifest.json`)) {
    console.error(
      `Skipping ${target}: ${dir} not built (run npm run build:${target})`,
    );
    continue;
  }
  const zip = `releases/hover-${target}-${version}.zip`;
  execSync(`rm -f "../../${zip}"; zip -rqX "../../${zip}" .`, {
    cwd: dir,
    stdio: "inherit",
    shell: "/bin/bash",
  });
  console.log(`Packaged ${zip}`);
}
