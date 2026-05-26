"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { TrackingHandles } from "@/lib/tracking/mediapipe";
import type { HandLandmarkerResult, PoseLandmarkerResult } from "@mediapipe/tasks-vision";

interface UseTrackingOptions {
  /** The video element to track against. Must be playing for init to proceed. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Set to false to skip init / trigger teardown. */
  enabled: boolean;
}

/**
 * Normalized face bounding box derived from pose landmarks (RAW MediaPipe space).
 *
 * ── Coordinate note ─────────────────────────────────────────────────────────
 *   All values are in the RAW (unmirrored) video coordinate space, normalized
 *   [0,1] with origin top-left — exactly as MediaPipe emits them.
 *
 *   Consumers MUST apply the same mirror + crop transform that the mosaic uses
 *   before mapping to screen/shader coordinates:
 *     x_screen = 1 - centerX           (selfie mirror)
 *     then apply UV_ZOOM crop           (see use-tracking coordinate notes)
 *
 *   `active` is false when no pose is detected this frame.
 * ────────────────────────────────────────────────────────────────────────────
 */
export interface FaceBbox {
  /** Horizontal center of face region, normalized [0,1], RAW space. */
  centerX: number;
  /** Vertical center of face region, normalized [0,1], RAW space. */
  centerY: number;
  /**
   * Radius of the bounding circle that encloses the face landmark cluster,
   * expressed as a fraction of video height.  Use as a rough scale for the
   * face region size.
   */
  radius: number;
  /** True when a pose was detected this frame and the bbox is valid. */
  active: boolean;
}

export interface UseTrackingResult {
  /**
   * Ref holding the latest HandLandmarkerResult (populated every rAF frame).
   * Read this in your own rAF / useFrame — NOT reactive, no re-render cost.
   *
   * landmarks[hand][point] — normalized [0,1] with origin top-left of the
   * RAW (unmirrored) video frame.
   *
   * ── Coordinate mapping notes for iter 16 ──────────────────────────────────
   *   MediaPipe space  →  mosaic/screen space
   *
   *   1. Mirror (selfie): x_screen = 1 - x_mp
   *      The mosaic renders a mirrored selfie; MediaPipe landmarks are in raw
   *      (camera-facing) space, so flip X to match what the user sees.
   *
   *   2. 16:9 → 1:1 crop (same math as Mosaic.tsx UV construction):
   *        aspect  = videoWidth / videoHeight   (typically 16/9)
   *        uSlice  = 1 / aspect                 (width of 1:1 window in UV)
   *        uPad    = (1 - uSlice) / 2           (left dead band)
   *        uCenter = uPad + uSlice * 0.5
   *        vCenter = 0.5
   *
   *   3. Apply UV_ZOOM (= 1.25 in mosaic.tsx):
   *        uHalf   = uSlice / (2 * UV_ZOOM)
   *        vHalf   = 0.5   / UV_ZOOM
   *        uMinZ   = uCenter - uHalf
   *        uMaxZ   = uCenter + uHalf
   *        vMinZ   = vCenter - vHalf
   *        vMaxZ   = vCenter + vHalf
   *
   *   4. Map landmark into the cropped+zoomed square [0,1]:
   *        u_cropped = (x_screen - uMinZ) / (uMaxZ - uMinZ)
   *        v_cropped = (y_mp     - vMinZ) / (vMaxZ - vMinZ)
   *        where x_screen = 1 - x_mp  (from step 1)
   *
   *   Both u_cropped and v_cropped may fall outside [0,1] for off-screen
   *   landmarks; clamp before use.
   * ──────────────────────────────────────────────────────────────────────────
   */
  landmarksRef: React.RefObject<HandLandmarkerResult | null>;
  /** Reactive hand count (0, 1, or 2). Updated at most once per second. */
  handCount: number;
  /**
   * Ref holding the latest PoseLandmarkerResult (populated every rAF frame).
   * 33 normalized landmarks per detected pose. RAW (unmirrored) space.
   * Null when no pose is detected or pose landmarker is not yet ready.
   */
  poseRef: React.RefObject<PoseLandmarkerResult | null>;
  /**
   * Ref holding the computed face bounding box for the current frame.
   * Derived from nose (0), eye/ear landmarks (1-8), and shoulders (11,12).
   * RAW MediaPipe space — consumers must apply mirror + crop transforms.
   * See FaceBbox for coordinate details.
   */
  faceBboxRef: React.RefObject<FaceBbox>;
  /**
   * Iter 18 — THREE.DataTexture holding the latest selfie segmentation mask.
   *
   * Format: THREE.RedFormat, THREE.FloatType — single channel [0, 1] per pixel
   * where 1.0 = person, 0.0 = background.
   *
   * Resolution: MASK_SIZE × MASK_SIZE (256×256) — small enough to upload every
   * frame cheaply; the mosaic shader bilinearly samples it at each cell UV.
   *
   * ── Coordinate alignment note ──────────────────────────────────────────────
   *   The segmentation mask is produced in RAW (unmirrored) video space —
   *   exactly the same coordinate system as the aUv values stored on each
   *   mosaic point. The mosaic's aUv already encodes the mirror + crop + zoom
   *   transform (see UV crop math in mosaic.tsx). Sampling the mask texture at
   *   vUv (the per-cell aUv) therefore gives the correct mask value for each
   *   cell WITHOUT any additional transform — mask and video are automatically
   *   aligned because they share the same UV.
   *
   *   Concretely: the geometry builder computes
   *     u = uMaxZ - normCol * uSliceZ   ← mirrored
   *     v = vMinZ + (1 - normRow) * vSliceZ
   *   and passes this as aUv → vUv. Sampling uMask at vUv samples the mask at
   *   the mirrored+cropped video position for that cell. The mask pixel at that
   *   position was produced from the same video frame (same U/V in raw space),
   *   so they match perfectly.
   * ──────────────────────────────────────────────────────────────────────────
   *
   * Null until the segmenter is initialised and has produced its first result.
   * Mosaic should guard with uMaskActive=0 while null.
   */
  maskTextureRef: React.RefObject<THREE.DataTexture | null>;
}

/** How often to sync `handCount` state (ms). Avoids per-frame re-renders. */
const HAND_COUNT_THROTTLE_MS = 1000;

// ---------------------------------------------------------------------------
// Iter 25 — Per-detector target frame rates (easy to tune)
// ---------------------------------------------------------------------------

/**
 * Target detection rate for the hand + pose landmarkers (frames per second).
 * 30 fps is half the typical render cadence; the mosaic's per-frame lerp
 * interpolates landmark positions smoothly between detection updates.
 */
const HAND_POSE_FPS = 30;

/**
 * Target detection rate for the selfie segmentation pass (frames per second).
 * Segmentation is the most expensive detector (~5–15 ms per frame on a typical
 * laptop GPU via WASM). 18 fps is sufficient because the person silhouette
 * changes slowly and the mask is bilinearly upscaled by the GPU shader.
 */
const SEG_FPS = 18;

/** Derived minimum interval (ms) between hand/pose detect calls. */
const HAND_POSE_INTERVAL_MS = 1000 / HAND_POSE_FPS; // ~33 ms

/** Derived minimum interval (ms) between segmentation calls. */
const SEG_INTERVAL_MS = 1000 / SEG_FPS; // ~56 ms

/**
 * Iter 18 — Segmentation mask texture resolution.
 * 256×256 is small enough to upload cheaply every frame while giving the
 * mosaic shader a smooth, bilinearly-sampled person silhouette.
 * The GPU bilinear filter handles the upscale to screen resolution.
 */
const MASK_SIZE = 256;

/**
 * Pose landmark indices used for face bbox computation.
 *
 * MediaPipe BlazePose 33-point topology:
 *   0  = nose
 *   1  = left eye (inner)
 *   2  = left eye
 *   3  = left eye (outer)
 *   4  = right eye (inner)
 *   5  = right eye
 *   6  = right eye (outer)
 *   7  = left ear
 *   8  = right ear
 *   11 = left shoulder  (anchors the lower face region)
 *   12 = right shoulder
 *
 * Shoulders are included to give the bbox enough vertical extent to capture
 * the head + neck region, which is useful for the face-density pass (iter 23).
 */
const FACE_LANDMARK_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12] as const;

/**
 * Derive a face bounding circle from a subset of pose landmarks.
 * Returns an inactive bbox when no pose or insufficient landmarks are present.
 */
function computeFaceBbox(poseResult: PoseLandmarkerResult | null): FaceBbox {
  const inactive: FaceBbox = { centerX: 0.5, centerY: 0.3, radius: 0.15, active: false };

  if (!poseResult || poseResult.landmarks.length === 0) return inactive;

  const pose = poseResult.landmarks[0];
  if (!pose || pose.length < 13) return inactive;

  // Collect the face/shoulder landmark positions.
  const pts: Array<{ x: number; y: number }> = [];
  for (const idx of FACE_LANDMARK_INDICES) {
    const lm = pose[idx];
    if (lm) pts.push({ x: lm.x, y: lm.y });
  }
  if (pts.length === 0) return inactive;

  // Centroid.
  let sumX = 0;
  let sumY = 0;
  for (const p of pts) {
    sumX += p.x;
    sumY += p.y;
  }
  const centerX = sumX / pts.length;
  const centerY = sumY / pts.length;

  // Radius = max distance from centroid to any included landmark.
  let radius = 0;
  for (const p of pts) {
    const dx = p.x - centerX;
    const dy = p.y - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > radius) radius = dist;
  }

  // Clamp radius to a sensible minimum (avoids 0 when the person is perfectly
  // centred with all landmarks coincident — extremely unlikely but defensive).
  radius = Math.max(radius, 0.05);

  return { centerX, centerY, radius, active: true };
}

/**
 * Owns the HandLandmarker + PoseLandmarker lifecycle:
 *   init → single rAF detect loop (both detectors, strictly increasing timestamps) → teardown.
 *
 * Iteration 17 additions:
 *   - PoseLandmarker initialised from the same FilesetResolver (one fetch).
 *   - Both detectors run in the SAME rAF loop with the same `now` timestamp.
 *   - poseRef + faceBboxRef exposed for downstream consumers.
 *   - Both landmarkers closed on teardown.
 *
 * Iteration 18 additions:
 *   - ImageSegmenter (selfie_segmenter) initialised alongside the other two.
 *   - segmentForVideo called each rAF frame via callback API.
 *   - Confidence mask Float32 data uploaded into a THREE.DataTexture (RedFormat,
 *     FloatType) which is updated in-place each frame (needsUpdate = true).
 *   - maskTextureRef exposed; mosaic guards with uMaskActive before mask is ready.
 *   - ImageSegmenter closed on teardown.
 */
export function useTracking({
  videoRef,
  enabled,
}: UseTrackingOptions): UseTrackingResult {
  const handlesRef = useRef<TrackingHandles | null>(null);
  const landmarksRef = useRef<HandLandmarkerResult | null>(null);
  const poseRef = useRef<PoseLandmarkerResult | null>(null);
  const faceBboxRef = useRef<FaceBbox>({ centerX: 0.5, centerY: 0.3, radius: 0.15, active: false });
  const maskTextureRef = useRef<THREE.DataTexture | null>(null);
  const mountedRef = useRef(true);
  const [handCount, setHandCount] = useState(0);

  // Track component mount lifetime so cleanup callbacks can skip setState
  // after the component has unmounted (avoids React's setState-on-unmounted warning).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Only run in the browser — WASM cannot load server-side.
    if (typeof window === "undefined") return;
    if (!enabled) return;

    let cancelled = false;
    let rafId = 0;
    // Iter 25 — Per-detector last-called timestamps (ms).
    // Each detector tracks its own clock independently so the throttle intervals
    // can differ. MediaPipe requires strictly increasing timestamps per detector
    // instance; using `now` (performance.now()) guarantees monotonicity as long
    // as we only call each detector when now > lastXxxTime (enforced below).
    let lastHandPoseTime = -1;
    let lastSegTime = -1;
    // Throttle hand-count state updates to avoid flooding React with renders.
    let lastHandCountUpdate = 0;
    // Log detect errors at most once so the console isn't spammed each frame.
    let handErrorLogged = false;
    let poseErrorLogged = false;

    async function init() {
      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        // Video not ready yet; the effect will re-run when `enabled` toggles or
        // the component re-renders with a ready video element.
        return;
      }

      try {
        // Lazy import — createTrackingHandles does the dynamic import of
        // @mediapipe/tasks-vision, so nothing from that package runs server-side.
        // The FilesetResolver is created ONCE inside createTrackingHandles and
        // shared between HandLandmarker and PoseLandmarker — no duplicate fetch.
        const { createTrackingHandles } = await import(
          "@/lib/tracking/mediapipe"
        );

        if (cancelled) return; // unmounted while awaiting

        const handles = await createTrackingHandles();

        if (cancelled) {
          // Unmounted while models were loading — clean up immediately.
          handles.hand.close();
          handles.pose.close();
          return;
        }

        handlesRef.current = handles;
        console.log("[tracking] hand + pose landmarkers ready — starting detect loop");

        // ── rAF detect loop ────────────────────────────────────────────────
        // Both detectors share the SAME `now` timestamp per frame, satisfying
        // MediaPipe's requirement that timestamps strictly increase per call.
        // Iter 25 — Segmentation error should also log only once.
        let segErrorLogged = false;

        function detectFrame() {
          if (cancelled) return;

          // Iter 25 — Pause detection when the tab is hidden.
          // document.hidden is false for the active tab; true when minimised or
          // switched away. Skipping all detection saves CPU/power with no visual
          // impact because the user cannot see the canvas anyway.
          if (document.hidden) {
            rafId = requestAnimationFrame(detectFrame);
            return;
          }

          const video = videoRef.current;
          const handles = handlesRef.current;

          if (video && handles && video.readyState >= 2 && !video.paused) {
            // Sample `now` once per rAF tick. It is monotonically increasing
            // (performance.now() never goes backwards), so passing `now` to any
            // detector that last ran at `now - interval` satisfies MediaPipe's
            // strictly-increasing-timestamp requirement.
            const now = performance.now();

            // ── Iter 25: Hand + Pose detect (throttled to HAND_POSE_FPS) ──────
            // Run hand and pose together when their shared interval has elapsed.
            // Both detectors receive the SAME `now`; each has its own internal
            // last-timestamp state so passing the same value to two separate
            // instances is accepted by MediaPipe.
            if (now - lastHandPoseTime >= HAND_POSE_INTERVAL_MS) {
              // ── Hand detect ───────────────────────────────────────────────
              try {
                const handResult = handles.hand.landmarker.detectForVideo(video, now);
                landmarksRef.current = handResult;

                // Throttle reactive hand count updates.
                const count = handResult.landmarks.length;
                const elapsed = now - lastHandCountUpdate;
                if (elapsed >= HAND_COUNT_THROTTLE_MS) {
                  setHandCount(count);
                  lastHandCountUpdate = now;
                }
              } catch (err) {
                if (!handErrorLogged) {
                  console.error("[tracking] hand detectForVideo error:", err);
                  handErrorLogged = true;
                }
              }

              // ── Pose detect ───────────────────────────────────────────────
              // Uses the SAME `now` — both calls get an identical strictly-
              // increasing timestamp; MediaPipe accepts this because they are
              // separate detector instances (each tracks its own last-ts state).
              try {
                const poseResult = handles.pose.landmarker.detectForVideo(video, now);
                poseRef.current = poseResult;
                faceBboxRef.current = computeFaceBbox(poseResult);
              } catch (err) {
                if (!poseErrorLogged) {
                  console.error("[tracking] pose detectForVideo error:", err);
                  poseErrorLogged = true;
                }
              }

              lastHandPoseTime = now;
            }

            // ── Iter 25: Segmentation detect (throttled to SEG_FPS) ───────────
            // Segmentation is the most expensive detector (~5–15 ms/call on WASM).
            // Running it at ~18 fps instead of 60 fps yields ~3× fewer calls with
            // no perceptible quality loss — the silhouette changes slowly and the
            // mosaic shader bilinearly upsamples the 256×256 mask. The callback
            // API is synchronous (result arrives before next rAF tick in Chromium).
            //
            // ── Mask upload strategy ─────────────────────────────────────────
            // We use THREE.DataTexture (RedFormat, FloatType, MASK_SIZE²) and
            // update it in-place each call. Compared to a CanvasTexture:
            //   + No canvas 2D context allocation.
            //   + Direct Float32Array → GPU upload; no per-frame RGBA encode.
            //   + LinearFilter bilinear upscaling is free on the GPU.
            //   - Requires explicit needsUpdate = true each call (done below).
            //
            // ── Coordinate note ──────────────────────────────────────────────
            // The MediaPipe mask is in RAW (unmirrored) video space.
            // aUv values on each mosaic point already encode the mirrored +
            // cropped + zoomed UV (see mosaic.tsx UV crop math). Sampling
            // uMask at vUv (= aUv) thus reads the correct raw-space pixel for
            // each cell — no additional transform is needed in the shader.
            if (now - lastSegTime >= SEG_INTERVAL_MS) {
              try {
                handles.segmenter.segmenter.segmentForVideo(
                  video,
                  now,
                  (segResult) => {
                    // Guard: if the effect was cancelled while the segmentation
                    // callback was in-flight, discard the result entirely.
                    // Without this guard, the callback would allocate a new
                    // DataTexture (maskTextureRef.current is null after disposal)
                    // and store it in the ref — leaking GPU memory with no owner
                    // to dispose it.
                    if (cancelled) return;

                    const masks = segResult.confidenceMasks;
                    if (!masks || masks.length === 0) return;

                    // confidenceMasks[0] = person probability channel.
                    // getAsFloat32Array() returns a flat Float32 array of
                    // width×height values in row-major order (origin top-left,
                    // same as the raw video frame).
                    const rawMask = masks[0].getAsFloat32Array();
                    const srcW = masks[0].width;
                    const srcH = masks[0].height;

                    // Allocate or reuse the DataTexture.
                    if (!maskTextureRef.current) {
                      // Allocate MASK_SIZE² float buffer. Initial fill = 0.0
                      // (all background) so the mosaic sees a safe value before
                      // the first real result arrives.
                      const buf = new Float32Array(MASK_SIZE * MASK_SIZE);
                      const tex = new THREE.DataTexture(
                        buf,
                        MASK_SIZE,
                        MASK_SIZE,
                        THREE.RedFormat,
                        THREE.FloatType,
                      );
                      tex.minFilter = THREE.LinearFilter;
                      tex.magFilter = THREE.LinearFilter;
                      tex.generateMipmaps = false;
                      // DataTexture defaults to flipY=false, but the VideoTexture
                      // (sampled at the same vUv) defaults to flipY=true. Without
                      // this, the mask reads upside-down vs the video and gates the
                      // wrong cells. Match the video so mask + feed align in V.
                      tex.flipY = true;
                      maskTextureRef.current = tex;
                    }

                    const tex = maskTextureRef.current;
                    // tex.image.data is typed as Uint8Array|Uint8ClampedArray in
                    // Three.js @types, but we constructed the DataTexture with
                    // FloatType so the underlying buffer is actually Float32Array.
                    // The double cast through unknown is the correct TS escape hatch.
                    const dst = tex.image.data as unknown as Float32Array;

                    // Downsample / resample the raw mask into MASK_SIZE×MASK_SIZE
                    // using nearest-neighbor (sufficient for a coarse segmentation
                    // mask; bilinear filtering on the GPU handles the visual result).
                    for (let row = 0; row < MASK_SIZE; row++) {
                      for (let col = 0; col < MASK_SIZE; col++) {
                        const srcCol = Math.floor((col / MASK_SIZE) * srcW);
                        const srcRow = Math.floor((row / MASK_SIZE) * srcH);
                        dst[row * MASK_SIZE + col] = rawMask[srcRow * srcW + srcCol];
                      }
                    }

                    tex.needsUpdate = true;
                  },
                );
              } catch (err) {
                // Log only once to avoid flooding the console.
                if (!segErrorLogged) {
                  console.error("[tracking] segmentForVideo error:", err);
                  segErrorLogged = true;
                }
              }

              lastSegTime = now;
            }
          }

          rafId = requestAnimationFrame(detectFrame);
        }

        rafId = requestAnimationFrame(detectFrame);
      } catch (err) {
        if (!cancelled) {
          console.error("[tracking] init failed:", err);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (handlesRef.current) {
        handlesRef.current.hand.close();
        handlesRef.current.pose.close();
        handlesRef.current.segmenter.close();
        handlesRef.current = null;
        console.log("[tracking] hand + pose + segmenter closed");
      }
      landmarksRef.current = null;
      poseRef.current = null;
      faceBboxRef.current = { centerX: 0.5, centerY: 0.3, radius: 0.15, active: false };
      // Dispose the DataTexture so the GPU memory is freed.
      if (maskTextureRef.current) {
        maskTextureRef.current.dispose();
        maskTextureRef.current = null;
      }
      // Only reset React state when the component is still mounted.
      // On hard unmount, mountedRef.current is false (set by the lifecycle
      // effect above) so we skip the setState. When `enabled` toggles to false
      // the component stays mounted and the reset goes through normally.
      if (mountedRef.current) {
        setHandCount(0);
      }
    };
  }, [enabled, videoRef]);

  return { landmarksRef, handCount, poseRef, faceBboxRef, maskTextureRef };
}
