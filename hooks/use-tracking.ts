"use client";

import { useEffect, useRef, useState } from "react";
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
}

/** How often to sync `handCount` state (ms). Avoids per-frame re-renders. */
const HAND_COUNT_THROTTLE_MS = 1000;

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
 */
export function useTracking({
  videoRef,
  enabled,
}: UseTrackingOptions): UseTrackingResult {
  const handlesRef = useRef<TrackingHandles | null>(null);
  const landmarksRef = useRef<HandLandmarkerResult | null>(null);
  const poseRef = useRef<PoseLandmarkerResult | null>(null);
  const faceBboxRef = useRef<FaceBbox>({ centerX: 0.5, centerY: 0.3, radius: 0.15, active: false });
  const [handCount, setHandCount] = useState(0);

  useEffect(() => {
    // Only run in the browser — WASM cannot load server-side.
    if (typeof window === "undefined") return;
    if (!enabled) return;

    let cancelled = false;
    let rafId = 0;
    // Track last timestamp passed to detectForVideo — MediaPipe throws if the
    // same (or earlier) timestamp is passed twice in VIDEO mode.
    let lastDetectedTime = -1;
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
        function detectFrame() {
          if (cancelled) return;

          const video = videoRef.current;
          const handles = handlesRef.current;

          if (video && handles && video.readyState >= 2 && !video.paused) {
            const now = performance.now();

            if (now > lastDetectedTime) {
              // ── Hand detect ─────────────────────────────────────────────
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

              // ── Pose detect ─────────────────────────────────────────────
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

              lastDetectedTime = now;
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
        handlesRef.current = null;
        console.log("[tracking] hand + pose landmarkers closed");
      }
      landmarksRef.current = null;
      poseRef.current = null;
      faceBboxRef.current = { centerX: 0.5, centerY: 0.3, radius: 0.15, active: false };
      setHandCount(0);
    };
  }, [enabled, videoRef]);

  return { landmarksRef, handCount, poseRef, faceBboxRef };
}
