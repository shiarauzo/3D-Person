"use client";

/**
 * use-mosaic-uniforms.ts — ShaderMaterial uniforms for the mosaic point-cloud.
 *
 * Responsibilities:
 *   - Build the full uniforms object once (useMemo with empty deps) — all
 *     mutations happen via direct value assignment, never via re-render.
 *   - Sync uPointSize whenever cellPx (DPR-scaled point diameter) changes.
 *   - Sync uDeformRadius / uDeformStrength whenever squarePx changes.
 *   - Sync all live-control uniforms whenever controls change.
 *
 * Returns:
 *   The uniforms Record<string, THREE.IUniform> — passed directly to
 *   <shaderMaterial uniforms={uniforms} />.
 *
 * Per-frame uniform mutations (uTime, uMask, hand/face deform) are NOT here;
 * they live in mosaic.tsx's useFrame so the per-frame path stays co-located
 * with the tracking-context reads.
 */

import { useMemo, useEffect } from "react";
import * as THREE from "three";
import { paletteAsVector3, PALETTE_SIZE } from "@/lib/palette";
import { CONTROLS_DEFAULTS, type ControlValues } from "@/lib/controls-defaults";

// ---------------------------------------------------------------------------
// Module-level constants (mirrors mosaic.tsx — no behaviour change)
// ---------------------------------------------------------------------------

const MASK_THRESHOLD = 0.5;
const MASK_GAMMA = 1.0;
const DEFORM_RADIUS_FACTOR = 0.18;   // fraction of squarePx
const DEFORM_STRENGTH_FACTOR = 0.07; // fraction of squarePx
const MOTION_ACCENT_BOOST = 1.5;
const MOTION_DEFORM_BOOST = 0.6;
const CHANNEL_SHIFT = 0.008;
const CHANNEL_FACE_BIAS = 1.0;
const CHANNEL_TEAR_BIAS = 0.6;
const FACE_CHAOS_BIAS = 0.45;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseMosaicUniformsOptions {
  cellPx: number;
  squarePx: number;
  controls: ControlValues;
}

export function useMosaicUniforms({
  cellPx,
  squarePx,
  controls,
}: UseMosaicUniformsOptions): Record<string, THREE.IUniform> {
  // -------------------------------------------------------------------------
  // Create uniforms object once — mutated directly thereafter
  // -------------------------------------------------------------------------
  const uniforms = useMemo<Record<string, THREE.IUniform>>(
    () => ({
      uPointSize:     { value: cellPx },
      uVoidColor:     { value: new THREE.Vector3(10 / 255, 15 / 255, 10 / 255) },
      uVoidThreshold: { value: CONTROLS_DEFAULTS.voidThreshold },
      uVoidLowerBias: { value: 0.06 },
      uVoidV0:        { value: 0.55 },
      uVoidV1:        { value: 0.90 },
      uPalette:       { value: paletteAsVector3() },
      uPaletteSize:   { value: PALETTE_SIZE },
      uPaletteMix:    { value: 1.0 },
      uLimeBias:      { value: CONTROLS_DEFAULTS.limeBias },
      uAccentAmount:  { value: CONTROLS_DEFAULTS.accentAmount },
      uAccents: {
        value: [
          new THREE.Vector3(0xff / 255, 0x2b / 255, 0xb5 / 255), // 3 Hot Magenta  #ff2bb5
          new THREE.Vector3(0x19 / 255, 0xe0 / 255, 0xe6 / 255), // 4 Electric Cyan #19e0e6
          new THREE.Vector3(0x21 / 255, 0x56 / 255, 0xff / 255), // 5 Cobalt Blue   #2156ff
          new THREE.Vector3(0xff / 255, 0x2a / 255, 0x2a / 255), // 6 Signal Red    #ff2a2a
          new THREE.Vector3(0xff / 255, 0x9c / 255, 0x2b / 255), // 7 Amber         #ff9c2b
        ],
      },
      // Hand deform uniforms — initial positions off-screen.
      uHand0:          { value: new THREE.Vector2(0, 0) },
      uHand1:          { value: new THREE.Vector2(0, 0) },
      uHandActive0:    { value: 0.0 },
      uHandActive1:    { value: 0.0 },
      uDeformRadius:   { value: squarePx * DEFORM_RADIUS_FACTOR },
      uDeformStrength: { value: squarePx * DEFORM_STRENGTH_FACTOR },
      // Segmentation mask uniforms — wired each frame once texture is ready.
      uMask:           { value: null },
      uMaskActive:     { value: 0.0 },
      uMaskThreshold:  { value: MASK_THRESHOLD },
      uMaskGamma:      { value: MASK_GAMMA },
      // Motion-reactive intensity uniforms.
      uMotion:            { value: 0.0 },
      uMotionAccentBoost: { value: MOTION_ACCENT_BOOST },
      uMotionDeformBoost: { value: MOTION_DEFORM_BOOST },
      // Horizontal tear-band uniforms.
      uTime:            { value: 0.0 },
      uTearBands:       { value: 30.0 },
      uTearProbability: { value: CONTROLS_DEFAULTS.tearProbability },
      uTearAmount:      { value: CONTROLS_DEFAULTS.tearAmount },
      // Pixel-sort streak uniforms.
      uSortThreshold:   { value: 0.55 },
      uSortRun:         { value: 0.08 },
      uSortAmount:      { value: 0.18 },
      // Face-density region uniforms.
      uFaceCenter:      { value: new THREE.Vector2(0.5, 0.35) },
      uFaceRadius:      { value: 0.25 },
      uFaceActive:      { value: 0.0 },
      uFaceAccentBoost: { value: CONTROLS_DEFAULTS.faceAccentBoost },
      uFaceChaosBias:   { value: FACE_CHAOS_BIAS },
      // Channel-shift RGB split uniforms.
      uChannelShift:    { value: CHANNEL_SHIFT },
      uChannelFaceBias: { value: CHANNEL_FACE_BIAS },
      uChannelTearBias: { value: CHANNEL_TEAR_BIAS },
      // V2 — Synthetic-field tuning uniforms.
      uNoiseScale:  { value: CONTROLS_DEFAULTS.noiseScale },
      uNoiseDrift:  { value: CONTROLS_DEFAULTS.noiseDrift },
      uGradientMix: { value: CONTROLS_DEFAULTS.gradientMix },
      uEdgeBoost:   { value: CONTROLS_DEFAULTS.edgeBoost },
      uLimeMix:     { value: CONTROLS_DEFAULTS.limeMix },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // intentionally empty — we mutate uniforms directly below
  );

  // -------------------------------------------------------------------------
  // Sync uPointSize on DPR / grid density change
  // -------------------------------------------------------------------------
  useEffect(() => {
    uniforms.uPointSize.value = cellPx;
  }, [cellPx, uniforms]);

  // -------------------------------------------------------------------------
  // Sync deform radius/strength on window resize
  // -------------------------------------------------------------------------
  useEffect(() => {
    uniforms.uDeformRadius.value   = squarePx * DEFORM_RADIUS_FACTOR;
    uniforms.uDeformStrength.value = squarePx * DEFORM_STRENGTH_FACTOR;
  }, [squarePx, uniforms]);

  // -------------------------------------------------------------------------
  // Sync live control values → shader uniforms
  // Called whenever any control value changes (user-driven, infrequent).
  // deformStrength is stored as a fraction of squarePx — multiply here so the
  // world-unit value accounts for the current canvas size.
  // -------------------------------------------------------------------------
  useEffect(() => {
    uniforms.uVoidThreshold.value   = controls.voidThreshold;
    uniforms.uTearProbability.value = controls.tearProbability;
    uniforms.uTearAmount.value      = controls.tearAmount;
    uniforms.uAccentAmount.value    = controls.accentAmount;
    uniforms.uLimeBias.value        = controls.limeBias;
    uniforms.uDeformStrength.value  = squarePx * controls.deformStrength;
    uniforms.uFaceAccentBoost.value = controls.faceAccentBoost;
    // V2 — sync synthetic-field knobs.
    uniforms.uNoiseScale.value  = controls.noiseScale;
    uniforms.uNoiseDrift.value  = controls.noiseDrift;
    uniforms.uGradientMix.value = controls.gradientMix;
    uniforms.uEdgeBoost.value   = controls.edgeBoost;
    uniforms.uLimeMix.value     = controls.limeMix;
  }, [controls, uniforms, squarePx]);

  return uniforms;
}
