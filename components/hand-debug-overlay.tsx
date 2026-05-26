"use client";

/**
 * HandDebugOverlay — iter 15 debug aid.
 *
 * Draws dots at each MediaPipe hand landmark over the video area so we can
 * visually confirm that tracking is working. Remove or toggle DEBUG_HANDS
 * in camera-gate.tsx once iter 16 is validated.
 *
 * Coordinate mapping:
 *   MediaPipe landmarks are in raw (unmirrored) video space, normalized [0,1]
 *   with origin top-left. The selfie mosaic mirrors the feed (x → 1-x). This
 *   overlay applies the same mirror so dots match the on-screen image.
 *
 *   The overlay canvas fills the viewport; we scale landmark positions by the
 *   canvas dimensions (width × height) so dots track regardless of window size.
 *   We do NOT apply UV_ZOOM crop here — this overlay is placed over the raw
 *   video area, not the cropped mosaic, so straight mirrored UV coords suffice
 *   for a debug check.
 */

import { useEffect, useRef } from "react";
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";

interface HandDebugOverlayProps {
  /** Ref to the latest landmarks — read every frame, no prop-drilling on state. */
  landmarksRef: React.RefObject<HandLandmarkerResult | null>;
}

/** Dot radius in CSS pixels. */
const DOT_RADIUS = 4;
/** Colors per hand (up to 2 hands). */
const HAND_COLORS = ["#00ff88", "#ff2bb5"] as const;

export default function HandDebugOverlay({
  landmarksRef,
}: HandDebugOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId = 0;
    let cancelled = false;

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    function drawFrame() {
      if (cancelled || !canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafId = requestAnimationFrame(drawFrame);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const result = landmarksRef.current;
      if (result) {
        const { width: W, height: H } = canvas;

        result.landmarks.forEach((hand, handIdx) => {
          const color = HAND_COLORS[handIdx % HAND_COLORS.length];
          ctx.fillStyle = color;
          ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ctx.lineWidth = 1;

          for (const lm of hand) {
            // Mirror x to match selfie display: x_screen = 1 - x_mp
            const screenX = (1 - lm.x) * W;
            const screenY = lm.y * H;

            ctx.beginPath();
            ctx.arc(screenX, screenY, DOT_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        });
      }

      rafId = requestAnimationFrame(drawFrame);
    }

    rafId = requestAnimationFrame(drawFrame);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
    };
  }, [landmarksRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9999,
      }}
      aria-hidden="true"
    />
  );
}
