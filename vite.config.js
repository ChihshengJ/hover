import { defineConfig } from "vite";
import { resolve } from "path";
import { pruneJunk } from "./scripts/clean_junk.mjs";
import {
  copyFileSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
);
const APP_VERSION = manifest.version;

// Build target: chrome (default) | firefox | safari.
// manifest.json is the Chrome base; manifests/<target>.json is deep-merged
// on top of it (a value of null deletes the key).
const TARGET = process.env.TARGET || "chrome";
const OUT_DIR = `dist/${TARGET}`;

/**
 * Deep-merge a per-target manifest patch into the base manifest.
 * Plain objects merge recursively, `null` deletes the key, and
 * everything else (scalars, arrays) replaces the base value.
 */
function mergeManifest(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof out[key] === "object" &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeManifest(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export default defineConfig({
  root: ".",
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __TARGET__: JSON.stringify(TARGET),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        background: resolve(__dirname, "background.ts"),
        content: resolve(__dirname, "content.ts"),
        popup: resolve(__dirname, "popup.html"),
      },
      output: {
        // Keep predictable names for extension scripts
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "background" || chunkInfo.name === "content") {
            return "[name].js";
          }
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
    outDir: OUT_DIR,
    emptyOutDir: true,
    // Needed for extension compatibility
    target: "esnext",
    minify: true, // Easier debugging during development
  },
  publicDir: "public",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  plugins: [
    {
      name: "inject-version-html",
      transformIndexHtml(html) {
        return html.replace(/%VERSION%/g, APP_VERSION);
      },
    },
    {
      // public/ picks up .DS_Store from Finder and Vite copies it verbatim
      // into dist/, where AMO's validator flags it. Drop it every build so
      // the output directory is submission-clean without a manual pass.
      name: "strip-junk-files",
      closeBundle() {
        const removed = pruneJunk(resolve(__dirname, OUT_DIR));
        if (removed.length) {
          console.log(`[vite] Stripped ${removed.length} junk file(s) from ${OUT_DIR}/`);
        }
      },
    },
    {
      // Write the merged per-target manifest into the output directory.
      name: "emit-target-manifest",
      closeBundle() {
        const patchPath = resolve(__dirname, `manifests/${TARGET}.json`);
        const patch = existsSync(patchPath)
          ? JSON.parse(readFileSync(patchPath, "utf8"))
          : {};
        const merged = mergeManifest(manifest, patch);
        writeFileSync(
          resolve(__dirname, OUT_DIR, "manifest.json"),
          JSON.stringify(merged, null, 2) + "\n",
        );
        console.log(`[vite] Emitted ${TARGET} manifest to ${OUT_DIR}/`);
      },
    },
    {
      // PDFium's licence and those of the libraries built into it, plus the
      // pdfium-binaries project's own, from the vendored release
      // (scripts/vendor_pdfium.ts).
      name: "copy-pdfium-licences",
      closeBundle() {
        const vendor = resolve(__dirname, "vendor/pdfium");
        const dest = resolve(__dirname, OUT_DIR, "licenses/pdfium");
        cpSync(resolve(vendor, "licenses"), dest, { recursive: true });
        copyFileSync(
          resolve(vendor, "LICENSE"),
          resolve(dest, "pdfium-binaries.txt"),
        );
      },
    },
    {
      name: "copy-wasm-to-public",
      buildStart() {
        const wasmSrc = resolve(__dirname, "vendor/pdfium/pdfium.wasm");
        const wasmDest = resolve(__dirname, "public/pdfium.wasm");

        if (!existsSync(wasmSrc)) {
          this.error("No vendor/pdfium/pdfium.wasm: run scripts/vendor_pdfium.ts");
        }

        // public/pdfium.wasm is gitignored and must match the bundled glue
        // exactly: after a release bump, a stale copy would load against the
        // wrong glue. So compare the bytes and re-copy whenever they differ.
        const src = readFileSync(wasmSrc);
        if (existsSync(wasmDest) && src.equals(readFileSync(wasmDest))) return;
        copyFileSync(wasmSrc, wasmDest);
        console.log("[vite] Copied vendor/pdfium/pdfium.wasm to public/");
      },
    },
  ],
});
