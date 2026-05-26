#!/usr/bin/env node
/**
 * copy-mediapipe-assets.mjs
 *
 * Vendors MediaPipe WASM and model assets into public/mediapipe/ so the app
 * doesn't depend on third-party CDNs at runtime.
 *
 * WASM files:  Copied from node_modules/@mediapipe/tasks-vision/wasm/ (local, always succeeds).
 * Model files: Downloaded from Google Storage IF NOT already present (cached; skip if exists).
 *              Download failures warn but do not crash — the runtime CDN fallback covers it.
 *
 * Run:
 *   node scripts/copy-mediapipe-assets.mjs
 *   bun scripts/copy-mediapipe-assets.mjs
 *   bun run assets
 *
 * Idempotent: safe to re-run at any time.
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  createWriteStream,
  unlinkSync,
  renameSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Destination directories ──────────────────────────────────────────────────
const WASM_DEST = resolve(ROOT, "public", "mediapipe", "wasm");
const MODELS_DEST = resolve(ROOT, "public", "mediapipe", "models");

// ─── WASM source (always local) ───────────────────────────────────────────────
const WASM_SRC = resolve(
  ROOT,
  "node_modules",
  "@mediapipe",
  "tasks-vision",
  "wasm"
);

// ─── Model downloads ──────────────────────────────────────────────────────────
const MODELS = [
  {
    filename: "hand_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
  },
  {
    filename: "pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
  },
  {
    filename: "selfie_segmenter.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`[assets] created ${dir}`);
  }
}

/**
 * Download a URL to destPath using streaming fetch.
 *
 * Writes to a temporary "<destPath>.part" file first; only renames it to the
 * final path on success.  Any partial file is unlinked on failure so a corrupt
 * download never persists and will be retried on the next run.
 *
 * Returns true on success, false on failure (after logging a warning).
 */
async function downloadFile(url, destPath) {
  const partPath = `${destPath}.part`;

  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    console.warn(
      `[assets] WARN: network error downloading ${basename(destPath)} — ${err.message}`
    );
    console.warn(
      `[assets] WARN: runtime CDN fallback will be used instead.`
    );
    return false;
  }

  if (!response.ok) {
    console.warn(
      `[assets] WARN: HTTP ${response.status} downloading ${basename(destPath)} from ${url}`
    );
    console.warn(`[assets] WARN: runtime CDN fallback will be used instead.`);
    return false;
  }

  try {
    const dest = createWriteStream(partPath);
    await pipeline(response.body, dest);
    // Atomic promotion: only rename to final path after a complete write.
    renameSync(partPath, destPath);
    return true;
  } catch (err) {
    // Remove the partial file so the next run retries the download.
    try {
      if (existsSync(partPath)) unlinkSync(partPath);
    } catch {
      // best-effort; ignore cleanup errors
    }
    console.warn(
      `[assets] WARN: failed writing ${basename(destPath)} — ${err.message}`
    );
    console.warn(`[assets] WARN: runtime CDN fallback will be used instead.`);
    return false;
  }
}

// ─── Step 1: Copy WASM from node_modules (must succeed — it's local) ─────────

console.log("[assets] copying WASM files from node_modules...");

if (!existsSync(WASM_SRC)) {
  console.error(
    `[assets] FATAL: WASM source not found at ${WASM_SRC}\n` +
      `  Run \`bun install\` first to install @mediapipe/tasks-vision.`
  );
  process.exit(1);
}

ensureDir(WASM_DEST);

const wasmFiles = readdirSync(WASM_SRC);
if (wasmFiles.length === 0) {
  console.error(`[assets] FATAL: no files found in ${WASM_SRC}`);
  process.exit(1);
}

let wasmCopied = 0;
for (const file of wasmFiles) {
  const src = resolve(WASM_SRC, file);
  const dest = resolve(WASM_DEST, file);
  // Always overwrite — node_modules may update on bun install.
  copyFileSync(src, dest);
  wasmCopied++;
}
console.log(`[assets] WASM: ${wasmCopied} files copied to ${WASM_DEST}`);

// ─── Step 2: Download models if not already present ───────────────────────────

console.log("[assets] checking model files...");
ensureDir(MODELS_DEST);

let modelsDownloaded = 0;
let modelsSkipped = 0;
let modelsFailed = 0;

for (const { filename, url } of MODELS) {
  const destPath = resolve(MODELS_DEST, filename);
  if (existsSync(destPath)) {
    console.log(`[assets] model ${filename} already present — skipping`);
    modelsSkipped++;
    continue;
  }

  console.log(`[assets] downloading ${filename}...`);
  const ok = await downloadFile(url, destPath);
  if (ok) {
    console.log(`[assets] model ${filename} downloaded`);
    modelsDownloaded++;
  } else {
    modelsFailed++;
  }
}

console.log(
  `[assets] models: ${modelsDownloaded} downloaded, ${modelsSkipped} already cached, ${modelsFailed} failed (CDN fallback active for those)`
);

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log("[assets] MediaPipe assets ready.");
