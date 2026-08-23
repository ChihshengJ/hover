// Ambient declarations for things that exist at runtime but have no JS
// declaration site: Vite's compile-time `define` constants and the
// non-JS modules Vite knows how to import.

/** App version, injected from manifest.json by vite.config.js. */
declare const __APP_VERSION__: string;

/** Build target: "chrome" | "firefox" | "safari". */
declare const __TARGET__: string;

/** True in store builds, where the remote pdfium CDN fallback is scrubbed. */
declare const __LOCAL_WASM_ONLY__: boolean;

// DOM expando properties. src/page.js hangs analysis records straight off the
// overlay elements it creates. docs/architecture_plan.md Phase 7 replaces these
// with WeakMaps; until then they are declared so checkJs can see them.
interface HTMLElement {
  /** Set on `.image-rect` overlays by PageView#renderImageRects. */
  _imageInfo?: unknown;
  /** Set on `.crossref-rect` overlays by PageView#renderCrossRefRects. */
  _crossRefData?: unknown;
}

// User-Agent Client Hints. Chromium-only and not yet in lib.dom; the liquid
// glass code uses the presence of `brands` as its Chromium check.
interface Navigator {
  userAgentData?: { brands: Array<{ brand: string; version: string }> };
}

declare module "*.css";
declare module "*.svg" {
  const src: string;
  export default src;
}
declare module "*.png" {
  const src: string;
  export default src;
}
