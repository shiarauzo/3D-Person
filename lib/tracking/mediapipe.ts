/**
 * MediaPipe bootstrap helpers.
 *
 * Asset paths default to the jsdelivr CDN (version-pinned).
 * For an offline / restricted deploy:
 *   1. Copy the wasm/ folder and *.task files from the CDN into public/.
 *   2. Replace WASM_BASE_URL with "/" and the MODEL_URLs with local paths.
 */

// NOTE: Do NOT import from "@mediapipe/tasks-vision" at module top-level — this
// file is imported lazily inside a useEffect so the WASM loader never runs on
// the server and next build stays safe.

const MP_VERSION = "0.10.35";

/** jsdelivr-hosted WASM bundle (matches the installed npm version). */
const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;

/** Google-hosted hand landmarker model (float16 full model, ~9 MB). */
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

/**
 * Google-hosted pose landmarker model (lite variant, ~3 MB).
 * Lite gives adequate landmark accuracy for face bbox computation at lower
 * inference cost than the full or heavy variants.
 */
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

/**
 * Google-hosted selfie segmenter model (~1 MB, single-class person mask).
 *
 * Model: selfie_segmenter (general variant, good for desk/webcam framing).
 * Outputs a single confidence mask channel (Float32) in [0, 1] per pixel
 * where 1.0 = definitely person, 0.0 = definitely background.
 *
 * URL source:
 *   https://storage.googleapis.com/mediapipe-models/image_segmenter/
 *     selfie_segmenter/float16/latest/selfie_segmenter.task
 *
 * The "selfie_multiclass" variant (5-class hair/skin/clothing/etc.) is NOT
 * used here — we only need a binary person vs. background probability.
 */
const SEGMENTER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.task";

// ─── Shared types ───────────────────────────────────────────────────────────

export interface HandLandmarkerHandle {
  /** The underlying MediaPipe HandLandmarker instance. */
  landmarker: import("@mediapipe/tasks-vision").HandLandmarker;
  /** Call this to free WASM resources. */
  close: () => void;
}

export interface PoseLandmarkerHandle {
  /** The underlying MediaPipe PoseLandmarker instance. */
  landmarker: import("@mediapipe/tasks-vision").PoseLandmarker;
  /** Call this to free WASM resources. */
  close: () => void;
}

export interface ImageSegmenterHandle {
  /** The underlying MediaPipe ImageSegmenter instance. */
  segmenter: import("@mediapipe/tasks-vision").ImageSegmenter;
  /** Call this to free WASM resources. */
  close: () => void;
}

/**
 * All three tracking handles, created from a single shared FilesetResolver so
 * the WASM bundle is only fetched once.
 */
export interface TrackingHandles {
  hand: HandLandmarkerHandle;
  pose: PoseLandmarkerHandle;
  /** Iter 18 — selfie segmenter producing a confidence mask for person pixels. */
  segmenter: ImageSegmenterHandle;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Initialise the MediaPipe WASM runtime ONCE, then create both a HandLandmarker
 * and a PoseLandmarker from the same fileset.
 *
 * - HandLandmarker: VIDEO mode, 2 hands, GPU delegate.
 * - PoseLandmarker: VIDEO mode, 1 pose, GPU delegate (lite model).
 *
 * Must be called from a browser context (not during SSR).
 * Throws if initialisation fails so the caller can surface the error.
 */
export async function createTrackingHandles(): Promise<TrackingHandles> {
  // Dynamic import — keeps the WASM loader out of the server bundle.
  const { FilesetResolver, HandLandmarker, PoseLandmarker, ImageSegmenter } =
    await import("@mediapipe/tasks-vision");

  // ── Single FilesetResolver fetch (shared by all three trackers) ────────────
  // Derive the type from forVisionTasks's return — WasmFileset is not publicly
  // exported from the package so we cannot reference it directly.
  let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  try {
    vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  } catch (err) {
    console.error("[tracking] FilesetResolver failed:", err);
    throw err;
  }

  // ── Create all three trackers in parallel ──────────────────────────────────
  let handLandmarker: import("@mediapipe/tasks-vision").HandLandmarker;
  let poseLandmarker: import("@mediapipe/tasks-vision").PoseLandmarker;
  let imageSegmenter: import("@mediapipe/tasks-vision").ImageSegmenter;

  try {
    [handLandmarker, poseLandmarker, imageSegmenter] = await Promise.all([
      HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: HAND_MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
      }),
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: POSE_MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      }),
      // Iter 18 — Selfie segmenter: confidence masks mode gives a Float32 [0,1]
      // person-probability per pixel, which we upload directly as a DataTexture.
      // outputCategoryMask is disabled; we use confidence masks for soft edges.
      ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: SEGMENTER_MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      }),
    ]);
  } catch (err) {
    console.error("[tracking] tracker createFromOptions failed:", err);
    throw err;
  }

  return {
    hand: {
      landmarker: handLandmarker,
      close: () => handLandmarker.close(),
    },
    pose: {
      landmarker: poseLandmarker,
      close: () => poseLandmarker.close(),
    },
    segmenter: {
      segmenter: imageSegmenter,
      close: () => imageSegmenter.close(),
    },
  };
}

// ─── Legacy export (kept for any direct imports that may exist) ───────────────

/**
 * @deprecated Use createTrackingHandles() instead — it shares the FilesetResolver.
 * Kept temporarily for backwards compat; will be removed in a future iteration.
 */
export async function createHandLandmarker(): Promise<HandLandmarkerHandle> {
  const handles = await createTrackingHandles();
  // Close the pose landmarker since caller won't manage it.
  handles.pose.close();
  return handles.hand;
}
