"use client";

/**
 * useDemoTracking
 *
 * Returns a UseTrackingResult populated with entirely fabricated data so the
 * Mosaic renders the synthetic glitch bust without a camera or MediaPipe.
 *
 * Fabricated inputs:
 *
 *   maskTextureRef — THREE.DataTexture (RedFormat, FloatType, 256×256) shaped
 *     like a centred frontal BUST: ellipse head, tapered neck, trapezoidal
 *     shoulders + chest.  Values are ~1.0 inside the silhouette, 0.0 outside.
 *     Coordinate space matches the real mask (RAW video space, flipY=true).
 *     Allocated once on mount; disposed on unmount.
 *
 *   faceBboxRef — centred at a typical head position (centerX=0.5, centerY=0.28)
 *     with a reasonable radius.  active=true always in demo mode.
 *
 *   landmarksRef — a single "hand" (hand 0) with one landmark orbiting slowly
 *     around the face in a small circle, so the deform / motion path is
 *     exercised. The orbit uses performance.now() for smooth animation and
 *     updates every rAF frame. Matches HandLandmarkerResult shape exactly.
 *
 *   poseRef — null (not needed; faceBboxRef is populated directly).
 *
 *   handCount — always 1 (the fabricated orbiting hand).
 *
 * Coordinate conventions (matching use-tracking.ts):
 *   - All normalized [0,1] with origin top-left of the raw video frame.
 *   - No mirror applied here — landmarks are in RAW space; Mosaic mirrors them
 *     the same way it does real landmarks.
 *   - The mask is in the same RAW space (flipY=true matches real mask).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { UseTrackingResult, FaceBbox } from "@/hooks/use-tracking";
import type { HandLandmarkerResult, PoseLandmarkerResult } from "@mediapipe/tasks-vision";

/** Resolution must match MASK_SIZE in use-tracking.ts (256). */
const MASK_SIZE = 256;

// ---------------------------------------------------------------------------
// Bust silhouette painter
// ---------------------------------------------------------------------------

/**
 * Paint a frontal bust silhouette into a flat Float32Array of MASK_SIZE×MASK_SIZE.
 * Values: 1.0 inside the body, 0.0 outside.
 * The silhouette is expressed in UV space [0,1] where V=0 is top (face), V=1 is bottom.
 *
 * Anatomy (all values in UV [0,1]):
 *   Head:       ellipse centred at (0.5, 0.22), radii (0.16 U, 0.18 V)
 *   Neck:       rectangle [0.44, 0.56] × [0.36, 0.46]
 *   Shoulders:  trapezoid — top width 0.32 centred at V=0.46, bottom width 0.62 at V=0.68
 *   Chest:      rectangle [0.22, 0.78] × [0.58, 0.85]
 *
 * Because DataTexture has flipY=true (same as the real mask), we paint in raw
 * top-left-origin space and let the GPU flip.
 */
function paintBustMask(buf: Float32Array): void {
  for (let row = 0; row < MASK_SIZE; row++) {
    for (let col = 0; col < MASK_SIZE; col++) {
      const u = col / (MASK_SIZE - 1); // [0, 1] left→right
      const v = row / (MASK_SIZE - 1); // [0, 1] top→bottom

      let inside = false;

      // ── Head ellipse ─────────────────────────────────────────────────────
      const hcx = 0.5, hcy = 0.22, hrx = 0.165, hry = 0.185;
      const hdu = (u - hcx) / hrx;
      const hdv = (v - hcy) / hry;
      if (hdu * hdu + hdv * hdv <= 1.0) inside = true;

      // ── Neck rectangle ───────────────────────────────────────────────────
      if (!inside && u >= 0.435 && u <= 0.565 && v >= 0.36 && v <= 0.47) inside = true;

      // ── Shoulders trapezoid ──────────────────────────────────────────────
      // Left and right edges are linear ramps from narrow (top) to wide (bottom).
      // Top of trapezoid: V=0.44, half-width=0.165 → left edge at u=0.335, right at u=0.665
      // Bottom: V=0.69, half-width=0.32 → left at u=0.18, right at u=0.82
      if (!inside && v >= 0.44 && v <= 0.69) {
        const t = (v - 0.44) / (0.69 - 0.44); // 0 at top, 1 at bottom
        const halfW = 0.165 + t * (0.32 - 0.165);
        const leftEdge = 0.5 - halfW;
        const rightEdge = 0.5 + halfW;
        if (u >= leftEdge && u <= rightEdge) inside = true;
      }

      // ── Chest rectangle ──────────────────────────────────────────────────
      if (!inside && u >= 0.18 && u <= 0.82 && v >= 0.60 && v <= 0.86) inside = true;

      buf[row * MASK_SIZE + col] = inside ? 1.0 : 0.0;
    }
  }
}

// ---------------------------------------------------------------------------
// Fabricated landmark helpers
// ---------------------------------------------------------------------------

/** Number of landmarks per hand in a real HandLandmarkerResult (21 points). */
const HAND_LANDMARK_COUNT = 21;

/**
 * Build a fake HandLandmarkerResult with one hand whose landmark 9 (HAND_LANDMARK_IDX
 * in mosaic.tsx) slowly orbits the face area.  The remaining 20 landmarks are set to
 * the same position (wrist) so the deform only fires near landmark 9.
 *
 * angle: orbit angle in radians (advances each frame)
 */
function buildFakeHandResult(angle: number): HandLandmarkerResult {
  // Centre the orbit around the face, slightly above.
  const cx = 0.65; // RAW space (will be mirrored → screen left side)
  const cy = 0.25;
  const r  = 0.12;

  const lm9x = cx + Math.cos(angle) * r;
  const lm9y = cy + Math.sin(angle) * r;

  // Build 21 landmarks. All except 9 sit at a static wrist-ish position.
  const landmarks: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < HAND_LANDMARK_COUNT; i++) {
    if (i === 9) {
      landmarks.push({ x: lm9x, y: lm9y, z: 0 });
    } else {
      landmarks.push({ x: cx, y: cy + 0.05, z: 0 });
    }
  }

  return {
    landmarks: [landmarks],
    worldLandmarks: [landmarks.map((lm) => ({ ...lm }))],
    handednesses: [[]],
    handWorldLandmarks: [landmarks.map((lm) => ({ ...lm }))],
  } as unknown as HandLandmarkerResult;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useDemoTracking(): UseTrackingResult {
  const landmarksRef = useRef<HandLandmarkerResult | null>(null);
  const poseRef      = useRef<PoseLandmarkerResult | null>(null);
  const faceBboxRef  = useRef<FaceBbox>({
    centerX: 0.5,
    centerY: 0.27,
    radius:  0.18,
    active:  true,
  });
  const maskTextureRef = useRef<THREE.DataTexture | null>(null);
  const [handCount] = useState(1);
  // Demo mode: models are never loaded; report "ready" immediately.
  const retryInit = useCallback(() => {}, []);

  // Allocate the mask texture on mount; dispose on unmount.
  useEffect(() => {
    const buf = new Float32Array(MASK_SIZE * MASK_SIZE);
    paintBustMask(buf);

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
    // Match the real mask: flipY=true so the silhouette is upright.
    tex.flipY = true;
    tex.needsUpdate = true;

    maskTextureRef.current = tex;

    return () => {
      tex.dispose();
      maskTextureRef.current = null;
    };
  }, []);

  // rAF loop: animate the hand landmark orbit + keep faceBboxRef live.
  useEffect(() => {
    let rafId = 0;
    let cancelled = false;

    function frame() {
      if (cancelled) return;

      const now = performance.now();
      // One full orbit every ~6 seconds.
      const angle = (now / 6000) * Math.PI * 2;

      landmarksRef.current = buildFakeHandResult(angle);

      // faceBboxRef: keep active=true; centerX/Y/radius are static for demo.
      // (Already initialised above; no update needed each frame.)

      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      landmarksRef.current = null;
    };
  }, []);

  return { landmarksRef, handCount, poseRef, faceBboxRef, maskTextureRef, initStatus: "ready", retryInit };
}
