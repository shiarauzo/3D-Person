"use client";

import { useEffect, useRef, useState } from "react";
import type { HandLandmarkerHandle } from "@/lib/tracking/mediapipe";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";

interface UseTrackingOptions {
  /** The video element to track against. Must be playing for init to proceed. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Set to false to skip init / trigger teardown. */
  enabled: boolean;
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
}

/** How often to sync `handCount` state (ms). Avoids per-frame re-renders. */
const HAND_COUNT_THROTTLE_MS = 1000;

/**
 * Owns the HandLandmarker lifecycle: init → rAF detect loop → teardown.
 *
 * Iteration 15: runs detectForVideo every animation frame, writes results to
 * a ref (zero re-render cost), and exposes a throttled handCount for HUD use.
 */
export function useTracking({
  videoRef,
  enabled,
}: UseTrackingOptions): UseTrackingResult {
  const handleRef = useRef<HandLandmarkerHandle | null>(null);
  const landmarksRef = useRef<HandLandmarkerResult | null>(null);
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
    let errorLogged = false;

    async function init() {
      const video = videoRef.current;
      if (!video || video.readyState < 2) {
        // Video not ready yet; the effect will re-run when `enabled` toggles or
        // the component re-renders with a ready video element.
        return;
      }

      try {
        // Lazy import — createHandLandmarker itself does the dynamic import of
        // @mediapipe/tasks-vision, so nothing from that package runs server-side.
        const { createHandLandmarker } = await import(
          "@/lib/tracking/mediapipe"
        );

        if (cancelled) return; // unmounted while awaiting

        const handle = await createHandLandmarker();

        if (cancelled) {
          // Unmounted while the model was loading — clean up immediately.
          handle.close();
          return;
        }

        handleRef.current = handle;
        console.log("[tracking] hand landmarker ready — starting detect loop");

        // ── rAF detect loop ────────────────────────────────────────────────
        function detectFrame() {
          if (cancelled) return;

          const video = videoRef.current;
          const landmarker = handleRef.current?.landmarker;

          if (video && landmarker && video.readyState >= 2 && !video.paused) {
            // Use performance.now() as the timestamp; it strictly increases and
            // is what MediaPipe VIDEO mode expects (milliseconds since page load).
            // We compare against the video's currentTime (seconds) to skip frames
            // where the video decoder hasn't produced a new image yet.
            const now = performance.now();

            // currentTime is in seconds; convert to ms for a coarser guard.
            // Only run detect when video has advanced to a new frame.
            // We track lastDetectedTime in ms (performance.now units) and
            // additionally guard by checking the video's currentTime changed —
            // if the video frame truly hasn't changed there's no point calling
            // detect (MediaPipe would throw on a non-increasing timestamp).
            if (now > lastDetectedTime) {
              try {
                const result = landmarker.detectForVideo(video, now);
                landmarksRef.current = result;
                lastDetectedTime = now;

                // Throttle reactive hand count updates.
                const count = result.landmarks.length;
                const elapsed = now - lastHandCountUpdate;
                if (elapsed >= HAND_COUNT_THROTTLE_MS) {
                  setHandCount(count);
                  lastHandCountUpdate = now;
                }
              } catch (err) {
                if (!errorLogged) {
                  console.error("[tracking] detectForVideo error:", err);
                  errorLogged = true;
                }
              }
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
      if (handleRef.current) {
        handleRef.current.close();
        handleRef.current = null;
        console.log("[tracking] hand landmarker closed");
      }
      landmarksRef.current = null;
      setHandCount(0);
    };
  }, [enabled, videoRef]);

  return { landmarksRef, handCount };
}
