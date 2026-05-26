/**
 * Iter 29 — Single source of truth for live-control defaults.
 *
 * Both the ControlsProvider initial state and the mosaic uniform init
 * import from here so the visual output at default is identical whether
 * or not the panel has been touched.
 *
 * Only shader-only knobs are exposed (no GRID_W — changing grid size
 * requires a geometry rebuild and is out of scope for iter 29).
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
}

export const CONTROLS_DEFAULTS: ControlValues = {
  voidThreshold:   0.20,
  tearProbability: 0.25,
  tearAmount:      0.035,
  accentAmount:    0.12,
  limeBias:        0.5,
  deformStrength:  0.07, // fraction of squarePx (same as DEFORM_STRENGTH_FACTOR)
  faceAccentBoost: 3.0,
};
