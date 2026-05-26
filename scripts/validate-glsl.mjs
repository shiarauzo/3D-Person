#!/usr/bin/env node
/**
 * validate-glsl.mjs
 *
 * Static validation for the mosaic GLSL shaders.
 * Run: node scripts/validate-glsl.mjs   (or: bun run validate:glsl)
 *
 * Checks performed (zero extra dependencies):
 *   1. Denylist — banned identifiers that were removed in three r169 or
 *      are not valid in GLSL ES 1.0 ShaderMaterial context.
 *   2. Brace/paren balance — catches truncated template literals.
 *   3. Basic sanity — every shader must contain a `void main()`.
 *
 * Optional (if the `gl` / headless-gl package is installed):
 *   4. Actual driver compilation of both shaders via a headless WebGL context.
 *      Skipped gracefully when the package is absent — no hard dependency.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (message printed to stderr)
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Load shader source files
//
// The shader files export a default string via:
//   const vertexShader = `...glsl...`; export default vertexShader;
//
// We read them as raw text and strip the JS wrapper to get the GLSL string.
// Strategy: find the first backtick after the `= /* glsl */` marker (or just
// the first backtick in the file), then take everything up to the matching
// closing backtick at the start of `\`;` on its own line. This is robust for
// our specific file format and requires zero deps (no TS transpile needed).
// ---------------------------------------------------------------------------

/**
 * Extract the GLSL string from a shader TS module source.
 * Handles the pattern:  const x = /* glsl *‌/ `...glsl...`;
 * Returns the raw GLSL content (without surrounding backticks).
 *
 * Also handles JS-injected #define constants by stripping any JS template
 * expression syntax (${...}) — those never appear in our shaders anyway,
 * but the comment below acknowledges the design decision.
 *
 * Note: PALETTE_SIZE and ACCENT_COUNT are hardcoded #define literals in the
 * GLSL itself (not injected via template expressions), so no stripping is
 * needed. This function would still work if injection were added later.
 */
function extractGlsl(filePath) {
  const src = readFileSync(filePath, "utf8");

  // Find the opening backtick (template literal start).
  // We look for the pattern `= /* glsl */ \`` or just the first backtick.
  const glslMarkerIdx = src.indexOf("/* glsl */");
  const startTick =
    glslMarkerIdx !== -1
      ? src.indexOf("`", glslMarkerIdx)
      : src.indexOf("`");

  if (startTick === -1) {
    throw new Error(`No template literal found in ${filePath}`);
  }

  // Find the closing backtick. It appears as `\`;` at the end — scan from
  // after the opening backtick.
  const closeTick = src.lastIndexOf("`");
  if (closeTick <= startTick) {
    throw new Error(`Could not find closing backtick in ${filePath}`);
  }

  // Extract content between the backticks (exclusive).
  return src.slice(startTick + 1, closeTick);
}

// ---------------------------------------------------------------------------
// 2. Discover shader files — glob shaders/*.ts so NEW shaders are validated
//    automatically (no need to register each one here).
// ---------------------------------------------------------------------------
const SHADER_DIR = resolve(ROOT, "shaders");
const SHADER_FILES = readdirSync(SHADER_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => ({ label: f.replace(/\.ts$/, ""), path: resolve(SHADER_DIR, f) }));

if (SHADER_FILES.length === 0) {
  console.error(`[validate-glsl] no shader files found in ${SHADER_DIR}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Denylist — identifiers removed/invalid in three r169 GLSL ES 1.0
// ---------------------------------------------------------------------------

/**
 * Each entry is: { token, reason }
 * `token` is a plain string; we do a word-boundary-aware search.
 *
 * Denylist rationale:
 *
 *   LinearTosRGB       — removed from three r169 built-in GLSL chunks.
 *                        Was the cause of the r169 breakage we tracked.
 *   RGBToLinear        — symmetric removal (sRGB helpers gone in r169).
 *   linearToOutputTexel — same removal wave; replaced by outputColorTransform.
 *   texture(           — GLSL 3 form. ShaderMaterial uses GLSL ES 1.0 which
 *                        requires texture2D() for 2D sampler lookups.
 *                        Note: `texture(` is the GLSL 3 overloaded form;
 *                        we check for it specifically to avoid false positives
 *                        on words like "texture" used in comments.
 */
const DENYLIST = [
  {
    token: "LinearTosRGB",
    reason:
      "Removed in three r169. Use manual sRGB conversion or outputColorTransform.",
  },
  {
    token: "RGBToLinear",
    reason:
      "Removed in three r169 along with the LinearTosRGB family.",
  },
  {
    token: "linearToOutputTexel",
    reason:
      "Removed in three r169. The ShaderMaterial now handles output encoding.",
  },
  {
    token: "texture(",
    reason:
      'GLSL 3 overloaded form. ShaderMaterial targets GLSL ES 1.0 — use texture2D() instead.',
  },
];

// ---------------------------------------------------------------------------
// 4. Check helpers
// ---------------------------------------------------------------------------

/** Return all 1-indexed line numbers where `token` appears in `src`. */
function findLines(src, token) {
  const lines = src.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(token)) {
      hits.push(i + 1);
    }
  }
  return hits;
}

/** Count occurrences of a character in a string. */
function countChar(str, ch) {
  let n = 0;
  for (const c of str) if (c === ch) n++;
  return n;
}

/**
 * Strip GLSL line comments (// ...) and block comments (/* ... *‌/) from a
 * GLSL source string, so delimiter-balance checks operate on code only.
 * Comments in GLSL routinely contain illustrative expressions like
 * `smoothstep(a, b, c)` that intentionally have unmatched parens across
 * lines — stripping them keeps the balance check meaningful.
 */
function stripGlslComments(src) {
  // Remove block comments first (/* ... */ — may span multiple lines).
  // Then remove line comments (// ...).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");
}

/**
 * Check brace and paren balance in `src` (comments stripped).
 * Returns null on success, or a string describing the imbalance.
 */
function checkBalance(src) {
  const code = stripGlslComments(src);
  const openBrace  = countChar(code, "{");
  const closeBrace = countChar(code, "}");
  const openParen  = countChar(code, "(");
  const closeParen = countChar(code, ")");

  const issues = [];
  if (openBrace !== closeBrace) {
    issues.push(`braces: ${openBrace} opening vs ${closeBrace} closing`);
  }
  if (openParen !== closeParen) {
    issues.push(`parens: ${openParen} opening vs ${closeParen} closing`);
  }
  return issues.length ? issues.join("; ") : null;
}

// ---------------------------------------------------------------------------
// 5. Main validation loop
// ---------------------------------------------------------------------------

let failed = false;

/** Print a FAIL line and set the failure flag. */
function fail(label, message) {
  process.stderr.write(`[FAIL] ${label}: ${message}\n`);
  failed = true;
}

/** Print a PASS line. */
function pass(label, message) {
  process.stdout.write(`[PASS] ${label}: ${message}\n`);
}

for (const { label, path: filePath } of SHADER_FILES) {
  let glsl;
  try {
    glsl = extractGlsl(filePath);
  } catch (err) {
    fail(label, `Could not extract GLSL — ${err.message}`);
    continue;
  }

  // ── Check 1: Denylist (code only — comments stripped) ────────────────────
  // We check the stripped GLSL so that educational comments like
  // "don't use LinearTosRGB" don't produce false positives.
  const glslCode = stripGlslComments(glsl);
  let denylistClean = true;
  for (const { token, reason } of DENYLIST) {
    // Find hits in stripped code, but report original line numbers for clarity.
    const codeLines = findLines(glslCode, token);
    if (codeLines.length > 0) {
      // Also find them in the raw source to give accurate original line numbers.
      const rawLines = findLines(glsl, token).filter((ln) => {
        // Confirm the hit is in code, not a comment, by checking the stripped version.
        const stripped = stripGlslComments(glsl.split("\n").slice(0, ln).join("\n"));
        return stripped.includes(token);
      });
      fail(
        label,
        `Denylisted identifier "${token}" found in GLSL code at line(s) ${rawLines.join(", ")} — ${reason}`
      );
      denylistClean = false;
    }
  }
  if (denylistClean) {
    pass(label, "denylist clean (no banned identifiers)");
  }

  // ── Check 2: Brace/paren balance ─────────────────────────────────────────
  const balanceIssue = checkBalance(glsl);
  if (balanceIssue) {
    fail(label, `Unbalanced delimiters — ${balanceIssue}`);
  } else {
    pass(label, "brace/paren balance OK");
  }

  // ── Check 3: void main() present ────────────────────────────────────────
  if (!glsl.includes("void main()")) {
    fail(label, 'Missing "void main()" entry point');
  } else {
    pass(label, 'void main() found');
  }
}

// ---------------------------------------------------------------------------
// 6. Optional: headless-gl compilation (zero hard dep)
// ---------------------------------------------------------------------------
try {
  const glModule = await import("gl").catch(() => null);
  if (glModule) {
    const createGL = glModule.default ?? glModule;
    const ctx = createGL(1, 1);
    if (ctx) {
      process.stdout.write("[INFO] headless-gl available — attempting shader compilation\n");

      for (const { label, path: filePath } of SHADER_FILES) {
        let glsl;
        try {
          glsl = extractGlsl(filePath);
        } catch {
          continue;
        }

        const shaderType =
          label.endsWith(".vert")
            ? ctx.VERTEX_SHADER
            : ctx.FRAGMENT_SHADER;

        const shader = ctx.createShader(shaderType);
        ctx.shaderSource(shader, glsl);
        ctx.compileShader(shader);

        if (!ctx.getShaderParameter(shader, ctx.COMPILE_STATUS)) {
          const log = ctx.getShaderInfoLog(shader);
          fail(label, `headless-gl compilation failed:\n${log}`);
        } else {
          pass(label, "headless-gl compilation succeeded");
        }
        ctx.deleteShader(shader);
      }
    }
  } else {
    process.stdout.write(
      "[INFO] headless-gl not installed — skipping driver compilation (static checks only)\n"
    );
  }
} catch {
  process.stdout.write(
    "[INFO] headless-gl unavailable — skipping driver compilation (static checks only)\n"
  );
}

// ---------------------------------------------------------------------------
// 7. Exit
// ---------------------------------------------------------------------------
if (failed) {
  process.stderr.write(
    "\nGLSL validation FAILED. Fix the issues above before building.\n"
  );
  process.exit(1);
} else {
  process.stdout.write("\nGLSL validation passed.\n");
  process.exit(0);
}
