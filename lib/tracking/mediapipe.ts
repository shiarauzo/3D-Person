/**
 * MediaPipe bootstrap helpers.
 *
 * Asset paths default to the jsdelivr CDN (version-pinned).
 * For an offline / restricted deploy:
 *   1. Copy the wasm/ folder and hand_landmarker.task from the CDN into public/.
 *   2. Replace WASM_BASE_URL with "/" and MODEL_URL with "/hand_landmarker.task".
 */

// NOTE: Do NOT import from "@mediapipe/tasks-vision" at module top-level — this
// file is imported lazily inside a useEffect so the WASM loader never runs on
// the server and next build stays safe.

const MP_VERSION = "0.10.35";

/** jsdelivr-hosted WASM bundle (matches the installed npm version). */
const WASM_BASE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;

/** Google-hosted hand landmarker model (float32 full model, ~9 MB). */
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";

export interface HandLandmarkerHandle {
  /** The underlying MediaPipe HandLandmarker instance. */
  landmarker: import("@mediapipe/tasks-vision").HandLandmarker;
  /** Call this to free WASM resources. */
  close: () => void;
}

/**
 * Initialise the MediaPipe WASM runtime and create a HandLandmarker configured
 * for VIDEO mode with 2 hands and GPU delegate (CPU fallback is automatic).
 *
 * Must be called from a browser context (not during SSR).
 * Throws if initialisation fails so the caller can surface the error.
 */
export async function createHandLandmarker(): Promise<HandLandmarkerHandle> {
  // Dynamic import — keeps the WASM loader out of the server bundle.
  const { FilesetResolver, HandLandmarker } = await import(
    "@mediapipe/tasks-vision"
  );

  let vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  try {
    vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  } catch (err) {
    console.error("[tracking] FilesetResolver failed:", err);
    throw err;
  }

  let landmarker: import("@mediapipe/tasks-vision").HandLandmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
    });
  } catch (err) {
    console.error("[tracking] HandLandmarker.createFromOptions failed:", err);
    throw err;
  }

  return {
    landmarker,
    close: () => landmarker.close(),
  };
}
