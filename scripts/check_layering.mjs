/**
 * Enforce the one architectural rule that makes the src/analysis split worth
 * having: analysis/ may not depend on pdf/.
 *
 * DocumentTextIndex is the interface between them. Keeping the edge out means
 * the whole reference/citation engine runs in plain Node with no wasm, which
 * is what lets it be tested (docs/architecture_plan.md Phase 3).
 *
 * Two kinds of reference are treated differently:
 *
 *   - A runtime import (`import ... from`, `export ... from`, `import()`) is
 *     always a failure. That is the edge that would drag PDFium into Node.
 *   - A JSDoc `import('...')` in a type position is erased before runtime, so
 *     it costs nothing to execute — but it is still a design dependency, so
 *     the surviving ones are pinned to the allowlist below. Adding a new one
 *     fails here and has to be a deliberate decision.
 *
 * Run with `npm run check:layers`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * JSDoc-only references from analysis/ into pdf/ that are known and accepted.
 * Phase 5 removes the inline_extractor ones when the builders stop taking a
 * PDFium handle; PathObjectInfo is a plain geometry record that just happens
 * to be declared next to its producer.
 */
const ALLOWED_TYPE_REFS = new Set([
  "src/analysis/inline_extractor.js -> ../pdf/text_extractor.js",
  "src/analysis/text_index.js -> ../pdf/text_extractor.js",
]);

const FROM_DIR = "src/analysis";
const TO_DIR = "src/pdf";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

/** Strip block and line comments so the two passes below can't see each other's text. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

/** Resolve a specifier written in `file` and say whether it lands in pdf/. */
function targetsPdf(file, specifier) {
  if (!specifier.startsWith(".")) return false;
  const dir = file.slice(0, file.lastIndexOf("/"));
  const resolved = relative(".", join(dir, specifier)).replaceAll("\\", "/");
  return resolved.startsWith(TO_DIR + "/");
}

const RUNTIME = /(?:\b(?:import|export)\b[^;\n]*?\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g;
const JSDOC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const failures = [];
const seenTypeRefs = new Set();

for (const file of walk(FROM_DIR).sort()) {
  const source = readFileSync(file, "utf8");
  const code = stripComments(source);

  for (const [, specifier] of code.matchAll(RUNTIME)) {
    if (targetsPdf(file, specifier)) {
      failures.push(`${file}: runtime import of ${specifier}`);
    }
  }

  // Whatever stripComments blanked out is where the JSDoc lives.
  for (const [, specifier] of source.matchAll(JSDOC)) {
    if (!targetsPdf(file, specifier)) continue;
    const key = `${file} -> ${specifier}`;
    seenTypeRefs.add(key);
    if (!ALLOWED_TYPE_REFS.has(key)) {
      failures.push(
        `${file}: new JSDoc type reference to ${specifier}\n` +
          `    Either keep analysis/ free of pdf/, or add this to ` +
          `ALLOWED_TYPE_REFS in scripts/check_layering.mjs with a reason.`,
      );
    }
  }
}

for (const stale of ALLOWED_TYPE_REFS) {
  if (!seenTypeRefs.has(stale)) {
    failures.push(
      `stale allowlist entry in scripts/check_layering.mjs: ${stale}\n` +
        `    The reference is gone — delete the entry.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`${FROM_DIR}/ must not depend on ${TO_DIR}/:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `${FROM_DIR}/ has no runtime dependency on ${TO_DIR}/ ` +
    `(${ALLOWED_TYPE_REFS.size} allowed JSDoc type refs).`,
);
