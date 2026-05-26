"use client";

/**
 * Mosaic — thin R3F component wiring geometry, uniforms, and per-frame tracking.
 *
 * Internal structure (post-refactor, improvement #5):
 *
 *   lib/coords.ts              — pure coordinate math (unit-testable)
 *   hooks/use-mosaic-geometry  — geometry build + correctUVs + cropRef
 *   hooks/use-mosaic-uniforms  — uniforms useMemo + controls sync + resize sync
 *   components/mosaic.tsx      — per-frame tracking reads + <points> JSX
 *
 * The per-frame useFrame block lives here so the tracking-context refs
 * (landmarksRef, maskTextureRef, faceBboxRef) are read in one place.
 * cropRef is threaded from use-mosaic-geometry so world-space and vUv-space
 * conversions always use the same crop extents as the geometry.
 *
 * No logic changed — this is a mechanical extraction.
 */

import { useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";
import { useControlsContext } from "@/context/controls-context";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import vertexShader from "@/shaders/mosaic.vert";
import fragmentShader from "@/shaders/mosaic.frag";
import { useMosaicGeometry, GRID_W } from "@/hooks/use-mosaic-geometry";
import { useMosaicUniforms } from "@/hooks/use-mosaic-uniforms";
import { landmarkToWorld, landmarkToVUv, lerpScalar } from "@/lib/coords";

// ---------------------------------------------------------------------------
// Iter 16 — Hand deform tuning constants
// ---------------------------------------------------------------------------

/** Landmark index to use as the hand's representative position. 9 = MCP. */
const HAND_LANDMARK_IDX = 9;

/** Lerp speed for smoothing hand position each frame. */
const HAND_LERP_SPEED = 0.25;

/** Lerp speed for easing uHandActive in/out when a hand appears/disappears. */
const ACTIVE_LERP_SPEED = 0.15;

// ---------------------------------------------------------------------------
// Iter 20 — Motion-reactive intensity constants
// ---------------------------------------------------------------------------

/**
 * Normalisation divisor for hand speed → motion signal.
 * At 60 fps, fast arm movement ≈ 5 world-px/frame per hand → ~10 total.
 * MOTION_SPEED_MAX = 12 → peak motion ≈ 0.8–1.0 under fast movement.
 */
const MOTION_SPEED_MAX = 12.0;

/** Per-frame decay factor applied to uMotion when instantaneous speed drops. */
const MOTION_DECAY = 0.92;

// ---------------------------------------------------------------------------
// Iter 23 — Face-density region constants
// ---------------------------------------------------------------------------

/** Lerp speed for smoothing the face center position each frame. */
const FACE_CENTER_LERP = 0.12;

/** Lerp speed for smoothing the face radius each frame. */
const FACE_RADIUS_LERP = 0.08;

/** Lerp speed for easing uFaceActive in/out. */
const FACE_ACTIVE_LERP = 0.10;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Mosaic() {
  const { videoRef, status } = useWebcamContext();
  const { landmarksRef, maskTextureRef, faceBboxRef } = useTrackingContext();
  const { controls } = useControlsContext();
  const reducedMotion = useReducedMotion();

  const { size, gl } = useThree();

  // Square side in CSS pixels (shorter axis so grid fits fully).
  const squarePx = Math.min(size.width, size.height);

  // Cell size in physical pixels (DPR-scaled so points tile without gaps).
  // *1.02 nudge closes sub-pixel gaps at some DPR values.
  const dpr    = gl.getPixelRatio();
  const cellPx = (squarePx / GRID_W) * dpr * 1.02;

  // ── Geometry ──────────────────────────────────────────────────────────────
  // pointsRef is returned here so use-mosaic-geometry can reach the live geo
  // attributes for correctUVs without keeping a separate ref in this component.
  const { geometry, cropRef, pointsRef } = useMosaicGeometry({
    squarePx,
    videoRef,
    status,
  });

  // ── Uniforms ──────────────────────────────────────────────────────────────
  const uniforms = useMosaicUniforms({ cellPx, squarePx, controls });

  // ── Per-frame mutable state (no re-renders) ────────────────────────────────

  // Smoothed hand world-space positions.
  const smoothedHand0   = useRef(new THREE.Vector2(0, 0));
  const smoothedHand1   = useRef(new THREE.Vector2(0, 0));
  const smoothedActive0 = useRef(0);
  const smoothedActive1 = useRef(0);

  // Iter 23 — Smoothed face-region state.
  const smoothedFaceCenter = useRef(new THREE.Vector2(0.5, 0.35));
  const smoothedFaceRadius = useRef(0.25);
  const smoothedFaceActive = useRef(0);

  // Iter 20 — Motion signal state.
  const prevSmoothed0 = useRef(new THREE.Vector2(0, 0));
  const prevSmoothed1 = useRef(new THREE.Vector2(0, 0));
  const motionRef     = useRef(0);

  // ── useFrame: per-frame tracking reads → uniform mutations ────────────────
  useFrame(({ clock }) => {
    // Iter 21 — Elapsed time for tear-band quantization.
    uniforms.uTime.value = clock.getElapsedTime();

    // Task 5 — prefers-reduced-motion: override drift-speed and tear activity.
    // We mutate the uniforms directly here rather than in a useEffect so the
    // override fires every frame and can't be clobbered by the controls sync.
    // uReducedMotion is also set via useEffect in use-mosaic-uniforms for the
    // initial state, but the per-frame override below is the authoritative path.
    if (reducedMotion) {
      // Near-zero drift: the noise lattice barely moves, making the piece static.
      uniforms.uNoiseDrift.value     = 0.002;
      // Suppress tear bands: rare, subtle drift only.
      uniforms.uTearProbability.value = 0.02;
      // Hand deform still active (intentional — user gesture is not "motion" in
      // the OS sense; it's a direct, intentional interaction).
    } else {
      // Restore to user-controlled values.
      uniforms.uNoiseDrift.value      = controls.noiseDrift;
      uniforms.uTearProbability.value = controls.tearProbability;
    }

    // ── Segmentation mask ──────────────────────────────────────────────────
    const maskTex = maskTextureRef.current;
    if (maskTex) {
      uniforms.uMask.value       = maskTex;
      uniforms.uMaskActive.value = 1.0;
    }

    // ── Hand deform ────────────────────────────────────────────────────────
    const result = landmarksRef.current;
    const hands  = result?.landmarks ?? [];

    const crop = cropRef.current;

    // Hand 0
    if (hands.length >= 1) {
      const lm = hands[0][HAND_LANDMARK_IDX];
      if (lm) {
        const [tx, ty] = landmarkToWorld(lm.x, lm.y, crop, squarePx);
        smoothedHand0.current.x = lerpScalar(smoothedHand0.current.x, tx, HAND_LERP_SPEED);
        smoothedHand0.current.y = lerpScalar(smoothedHand0.current.y, ty, HAND_LERP_SPEED);
      }
      smoothedActive0.current = lerpScalar(smoothedActive0.current, 1, ACTIVE_LERP_SPEED);
    } else {
      smoothedActive0.current = lerpScalar(smoothedActive0.current, 0, ACTIVE_LERP_SPEED);
    }

    // Hand 1
    if (hands.length >= 2) {
      const lm = hands[1][HAND_LANDMARK_IDX];
      if (lm) {
        const [tx, ty] = landmarkToWorld(lm.x, lm.y, crop, squarePx);
        smoothedHand1.current.x = lerpScalar(smoothedHand1.current.x, tx, HAND_LERP_SPEED);
        smoothedHand1.current.y = lerpScalar(smoothedHand1.current.y, ty, HAND_LERP_SPEED);
      }
      smoothedActive1.current = lerpScalar(smoothedActive1.current, 1, ACTIVE_LERP_SPEED);
    } else {
      smoothedActive1.current = lerpScalar(smoothedActive1.current, 0, ACTIVE_LERP_SPEED);
    }

    // ── Face-density region ────────────────────────────────────────────────
    // vUv (= aUv) is the raw video texture coordinate; landmarkToVUv passes
    // centerX/centerY straight through because vUv IS the raw video space.
    // See lib/coords.ts landmarkToVUv for the coordinate rationale.
    {
      const faceBbox = faceBboxRef.current;

      if (faceBbox && faceBbox.active && crop.vSliceZ > 0) {
        const [u_vUv, v_vUv] = landmarkToVUv(faceBbox.centerX, faceBbox.centerY);
        const r_vUv = faceBbox.radius;

        smoothedFaceCenter.current.x = lerpScalar(smoothedFaceCenter.current.x, u_vUv, FACE_CENTER_LERP);
        smoothedFaceCenter.current.y = lerpScalar(smoothedFaceCenter.current.y, v_vUv, FACE_CENTER_LERP);
        smoothedFaceRadius.current   = lerpScalar(smoothedFaceRadius.current, r_vUv, FACE_RADIUS_LERP);
        smoothedFaceActive.current   = lerpScalar(smoothedFaceActive.current, 1, FACE_ACTIVE_LERP);
      } else {
        smoothedFaceActive.current = lerpScalar(smoothedFaceActive.current, 0, FACE_ACTIVE_LERP);
      }

      (uniforms.uFaceCenter.value as THREE.Vector2).copy(smoothedFaceCenter.current);
      uniforms.uFaceRadius.value = smoothedFaceRadius.current;
      uniforms.uFaceActive.value = smoothedFaceActive.current;
    }

    // ── Motion signal ──────────────────────────────────────────────────────
    // Sum per-frame displacement of each active hand's smoothed position.
    // Normalise by MOTION_SPEED_MAX → [0,1]; decay + max strategy.
    let rawSpeed = 0;

    if (smoothedActive0.current > 0.05) {
      rawSpeed += smoothedHand0.current.distanceTo(prevSmoothed0.current);
    }
    if (smoothedActive1.current > 0.05) {
      rawSpeed += smoothedHand1.current.distanceTo(prevSmoothed1.current);
    }

    // Store previous-frame positions AFTER computing delta.
    prevSmoothed0.current.copy(smoothedHand0.current);
    prevSmoothed1.current.copy(smoothedHand1.current);

    const instantaneous = Math.min(rawSpeed / MOTION_SPEED_MAX, 1.0);
    motionRef.current   = Math.max(motionRef.current * MOTION_DECAY, instantaneous);

    // Write hand + motion uniforms.
    (uniforms.uHand0.value as THREE.Vector2).copy(smoothedHand0.current);
    (uniforms.uHand1.value as THREE.Vector2).copy(smoothedHand1.current);
    uniforms.uHandActive0.value = smoothedActive0.current;
    uniforms.uHandActive1.value = smoothedActive1.current;
    uniforms.uMotion.value      = motionRef.current;
  });

  // V2: render guard pinned to webcam status (not texture).
  if (status !== "ready") return null;

  return (
    <points ref={pointsRef} geometry={geometry}>
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent={false}
        depthWrite={true}
        depthTest={true}
      />
    </points>
  );
}
