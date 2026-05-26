"use client";

import { useEffect, useRef } from "react";
import type { HandLandmarkerHandle } from "@/lib/tracking/mediapipe";

interface UseTrackingOptions {
  /** The video element to track against. Must be playing for init to proceed. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Set to false to skip init / trigger teardown. */
  enabled: boolean;
}

/**
 * Owns the HandLandmarker lifecycle.
 *
 * Iteration 14: init + teardown only (no per-frame detect loop yet — iter 15).
 * Iteration 15 will populate resultsRef with live HandLandmarkerResult values.
 */
export function useTracking({ videoRef, enabled }: UseTrackingOptions): void {
  const handleRef = useRef<HandLandmarkerHandle | null>(null);

  useEffect(() => {
    // Only run in the browser — WASM cannot load server-side.
    if (typeof window === "undefined") return;
    if (!enabled) return;

    let cancelled = false;

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
        console.log("[tracking] hand landmarker ready");
      } catch (err) {
        if (!cancelled) {
          console.error("[tracking] init failed:", err);
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      if (handleRef.current) {
        handleRef.current.close();
        handleRef.current = null;
        console.log("[tracking] hand landmarker closed");
      }
    };
  }, [enabled, videoRef]);
}
