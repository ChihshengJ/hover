import { defineConfig } from "vite";
import { resolve } from "path";
import { copyFileSync, existsSync } from "fs";

export default defineConfig({
  root: ".",
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
    outDir: "dist",
    emptyOutDir: true,
    // Needed for extension compatibility
    target: "esnext",
    minify: false, // Easier debugging during development
  },
  publicDir: "public",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  plugins: [
    {
      name: 'copy-popup-files',
      closeBundle() {
        // Copy popup.css and popup.js to dist (they're not processed by Vite)
        try {
          copyFileSync(
            resolve(__dirname, "popup.css"),
            resolve(__dirname, "dist/popup.css")
          );
          copyFileSync(
            resolve(__dirname, "popup.js"),
            resolve(__dirname, "dist/popup.js")
          );
        } catch (err) {
          console.warn("Could not copy popup files:", err.message);
        }
      }
    },
    {
      name: 'copy-wasm-to-public',
      buildStart() {
        // Copy pdfium.wasm from node_modules to public/ so it gets included in dist
        const wasmSrc = resolve(__dirname, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm");
        const wasmDest = resolve(__dirname, "public/pdfium.wasm");
        
        if (existsSync(wasmSrc) && !existsSync(wasmDest)) {
          try {
            copyFileSync(wasmSrc, wasmDest);
            console.log("[vite] Copied pdfium.wasm to public/");
          } catch (err) {
            console.warn("Could not copy pdfium.wasm:", err.message);
          }
        }
      }
    }
  ]
});
