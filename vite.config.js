import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
);
const APP_VERSION = manifest.version;
const STORE_BUILD = process.env.STORE_BUILD === "1";

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
    __LOCAL_WASM_ONLY__: JSON.stringify(STORE_BUILD),
    __TARGET__: JSON.stringify(TARGET),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        background: resolve(__dirname, "background.js"),
        content: resolve(__dirname, "content.js"),
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
      // In store builds, scrub the remote CDN URL baked into
      // @embedpdf/pdfium so reviewers don't flag it as remote code.
      name: "scrub-pdfium-cdn",
      enforce: "pre",
      transform(code, id) {
        if (!STORE_BUILD) return null;
        if (!id.includes("@embedpdf/pdfium")) return null;
        if (!code.includes("cdn.jsdelivr.net")) return null;
        return code.replace(
          /['"]https?:\/\/cdn\.jsdelivr\.net\/[^'"]*pdfium[^'"]*['"]/g,
          '""',
        );
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
      name: "copy-wasm-to-public",
      buildStart() {
        const wasmSrc = resolve(
          __dirname,
          "node_modules/@embedpdf/pdfium/dist/pdfium.wasm",
        );
        const wasmDest = resolve(__dirname, "public/pdfium.wasm");

        if (existsSync(wasmSrc) && !existsSync(wasmDest)) {
          try {
            copyFileSync(wasmSrc, wasmDest);
            console.log("[vite] Copied pdfium.wasm to public/");
          } catch (err) {
            console.warn("Could not copy pdfium.wasm:", err.message);
          }
        }
      },
    },
  ],
});
