"use client";

/**
 * HandDebugOverlay — iter 17 debug aid.
 *
 * Draws:
 *  - Dots at each MediaPipe hand landmark (iter 15).
 *  - Face bbox circle + selected pose key-points (iter 17, optional).
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
import type { HandLandmarkerResult, PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import type { FaceBbox } from "@/hooks/use-tracking";

interface HandDebugOverlayProps {
  /** Ref to the latest hand landmarks — read every frame, no re-render cost. */
  landmarksRef: React.RefObject<HandLandmarkerResult | null>;
  /**
   * Optional: ref to the latest pose result for drawing key-points.
   * If omitted the pose visualisation is skipped.
   */
  poseRef?: React.RefObject<PoseLandmarkerResult | null>;
  /**
   * Optional: ref to the face bounding box computed from pose landmarks.
   * Drawn as a circle on the overlay when active.
   */
  faceBboxRef?: React.RefObject<FaceBbox>;
}

/** Dot radius in CSS pixels. */
const DOT_RADIUS = 4;
/** Colors per hand (up to 2 hands). */
const HAND_COLORS = ["#00ff88", "#ff2bb5"] as const;
/** Color for the face bbox circle. */
const FACE_BBOX_COLOR = "#ffcc00";
/** Color for pose key-point dots. */
const POSE_DOT_COLOR = "rgba(255, 200, 0, 0.7)";
/** Radius for pose key-point dots (smaller than hand dots). */
const POSE_DOT_RADIUS = 3;

/**
 * Pose landmark indices to draw for the debug overlay.
 * Keeping to the face cluster + shoulders only (matches computeFaceBbox inputs).
 */
const POSE_DEBUG_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12] as const;

export default function HandDebugOverlay({
  landmarksRef,
  poseRef,
  faceBboxRef,
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

      const { width: W, height: H } = canvas;

      // ── Hand landmarks ────────────────────────────────────────────────────
      const handResult = landmarksRef.current;
      if (handResult) {
        handResult.landmarks.forEach((hand, handIdx) => {
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

      // ── Pose key-points ───────────────────────────────────────────────────
      const poseResult = poseRef?.current;
      if (poseResult && poseResult.landmarks.length > 0) {
        const pose = poseResult.landmarks[0];
        if (pose) {
          ctx.fillStyle = POSE_DOT_COLOR;
          ctx.strokeStyle = "rgba(0,0,0,0.4)";
          ctx.lineWidth = 1;

          for (const idx of POSE_DEBUG_INDICES) {
            const lm = pose[idx];
            if (!lm) continue;
            const screenX = (1 - lm.x) * W;
            const screenY = lm.y * H;
            ctx.beginPath();
            ctx.arc(screenX, screenY, POSE_DOT_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      }

      // ── Face bbox circle ──────────────────────────────────────────────────
      const bbox = faceBboxRef?.current;
      if (bbox?.active) {
        // Mirror centerX to match selfie display.
        const screenCX = (1 - bbox.centerX) * W;
        const screenCY = bbox.centerY * H;
        // radius is normalized to video height — scale by canvas height.
        const screenR = bbox.radius * H;

        ctx.beginPath();
        ctx.arc(screenCX, screenCY, screenR, 0, Math.PI * 2);
        ctx.strokeStyle = FACE_BBOX_COLOR;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small crosshair at center.
        const crossSize = 6;
        ctx.beginPath();
        ctx.moveTo(screenCX - crossSize, screenCY);
        ctx.lineTo(screenCX + crossSize, screenCY);
        ctx.moveTo(screenCX, screenCY - crossSize);
        ctx.lineTo(screenCX, screenCY + crossSize);
        ctx.strokeStyle = FACE_BBOX_COLOR;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      rafId = requestAnimationFrame(drawFrame);
    }

    rafId = requestAnimationFrame(drawFrame);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
    };
  }, [landmarksRef, poseRef, faceBboxRef]);

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
