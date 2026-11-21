/**
 * Loaded before every bun test file (`bunfig.toml`).
 */

// PDF dates without a zone offset are read in local time, so snapshots that
// hold dates would differ between machines without a fixed zone.
process.env.TZ = "UTC";

// Vite's build-time define (vite.config.js). Tests prime the wasm with
// `primePdfiumWasm()` and never resolve a URL, so this only decides what a
// test that forgot to prime gets: an error rather than a CDN download.
(globalThis as { __LOCAL_WASM_ONLY__?: boolean }).__LOCAL_WASM_ONLY__ = true;
