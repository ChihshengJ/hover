import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: ".",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
    outDir: "dist",
  },
  publicDir: "public",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});
