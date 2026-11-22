/**
 * Loaded before every bun test file (`bunfig.toml`).
 */

// PDF dates without a zone offset are read in local time, so snapshots that
// hold dates would differ between machines without a fixed zone.
process.env.TZ = "UTC";
