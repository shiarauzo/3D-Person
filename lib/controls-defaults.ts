/**
 * Iter 29 — Single source of truth for live-control defaults.
 *
 * Both the ControlsProvider initial state and the mosaic uniform init
 * import from here so the visual output at default is identical whether
 * or not the panel has been touched.
 *
 * Only shader-only knobs are exposed (no GRID_W — changing grid size
 * requires a geometry rebuild and is out of scope for iter 29).
 *
 * V2 — PLAN-V2 issue 11: five synthetic-field knobs added.
 * Default values exactly match the prior hardcoded GLSL literals so there
 * is no visual change when the panel is at its reset state.
 */

export interface ControlValues {
  /** Base luma threshold below which cells snap to void. */
  voidThreshold: number;
  /** Probability a band row tears horizontally. */
  tearProbability: number;
  /** Maximum horizontal UV shift magnitude for tear bands. */
  tearAmount: number;
  /** Base accent scatter probability per non-void cell. */
  accentAmount: number;
  /** Mid-luma lime-bias pull toward green swatches (0 = off, 1 = max). */
  limeBias: number;
  /** Maximum displacement magnitude for hand deform (fraction of squarePx). */
  deformStrength: number;
  /** Extra accent probability multiplier inside the face region. */
  faceAccentBoost: number;

  // ── V2 Synthetic-field knobs ─────────────────────────────────────────────
  /** Spatial frequency of the value noise lattice (smaller = bigger blobs). */
  noiseScale: number;
  /** uTime drift speed multiplier for the value noise. */
  noiseDrift: number;
  /** Weight of the vertical gradient in the noise/gradient blend (0=all noise, 1=all gradient). */
  gradientMix: number;
  /** Mask-edge hotness boost added to synthLuma at silhouette edges. */
  edgeBoost: number;
  /** Lime vs. procedural channel mix, via mix(limeBase, channel, limeMix) (0=full lime, 1=full channel). */
  limeMix: number;
}

export const CONTROLS_DEFAULTS: ControlValues = {
  voidThreshold:   0.20,
  tearProbability: 0.25,
  tearAmount:      0.040,
  accentAmount:    0.12,
  limeBias:        0.62,
  deformStrength:  0.07, // fraction of squarePx (same as DEFORM_STRENGTH_FACTOR)
  faceAccentBoost: 3.0,

  // V2 — defaults EXACTLY equal the prior hardcoded GLSL literals.
  noiseScale:  0.065, // was: cell * 0.065 in valueNoise call
  noiseDrift:  0.07,  // was: uTime * 0.07 in valueNoise call
  gradientMix: 0.35,  // was: vGrad * 0.35 in weighted blend (noise share = 1 - 0.35 = 0.65)
  edgeBoost:   0.35,  // was: edgeFactor * 0.35 in synthLuma clamp
  limeMix:     0.55,  // was: mix(limeBase, lum*, 0.55) in texColor
};
