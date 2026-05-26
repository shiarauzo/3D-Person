/**
 * lib/coords.ts — Pure coordinate math for the mosaic point-cloud.
 *
 * All functions here are PURE: no React hooks, no Three.js side-effects, no
 * global state. Three.js types (Vector2) are accepted/returned where they keep
 * the signature clear, but no mutations happen inside these functions — callers
 * mutate the objects they own.
 *
 * This module is the single source of truth for:
 *   - 16:9 → 1:1 centered-crop + UV_ZOOM mapping  (computeCropExtents)
 *   - Geometry aUv assignment per grid cell         (computeGridAuv)
 *   - MediaPipe landmark → world-space              (landmarkToWorld)
 *   - MediaPipe landmark → vUv-space (face center)  (landmarkToVUv)
 *
 * Coordinate system notes (identical to the inline comments in mosaic.tsx):
 *
 *   Video UV (raw, "vUv space"):
 *     Origin top-left. U increases rightward, V increases downward.
 *     This is what aUv / vUv hold in the shader.
 *
 *   Geometry / world space:
 *     Origin at canvas centre. X increases rightward, Y increases upward.
 *     squarePx is the side length so half = squarePx / 2.
 *
 *   MediaPipe normalized space:
 *     Origin top-left (same as raw video UV). Mirrored-selfie correction is
 *     xScreen = 1 - xMp before any further transform.
 *
 * IMPORTANT: do NOT change any math here without a matching change in the
 * GLSL shaders (mosaic.vert.ts / mosaic.frag.ts) and the UV correctUVs path
 * in use-mosaic-geometry.ts. The transforms must stay identical everywhere.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Zoomed crop extents in raw-video UV space.
 * All values are fractions of [0, 1] (raw video UV coordinates).
 *
 * uMinZ / uMaxZ: left / right edges of the zoomed crop window (U axis).
 * vMinZ / vMaxZ: top / bottom edges of the zoomed crop window (V axis).
 * uSliceZ: uMaxZ - uMinZ (total U width of the zoomed crop).
 * vSliceZ: vMaxZ - vMinZ (total V height of the zoomed crop).
 */
export interface CropExtents {
  uMinZ: number;
  uMaxZ: number;
  uSliceZ: number;
  vMinZ: number;
  vMaxZ: number;
  vSliceZ: number;
}

// ---------------------------------------------------------------------------
// 1. 16:9 → 1:1 crop + UV_ZOOM mapping
// ---------------------------------------------------------------------------

/**
 * Compute the zoomed crop extents in raw-video UV space.
 *
 * Implements the 3-step UV crop pipeline documented in mosaic.tsx:
 *
 *   Step 1 — 16:9 → 1:1 centered crop:
 *     uSlice = 1 / aspect          (width of the 1:1 window in raw UV space)
 *     uPad   = (1 - uSlice) / 2   (left dead band)
 *
 *   Step 2 — Apply uvZoom (> 1 makes subject appear larger):
 *     uCenter = uPad + uSlice * 0.5   (horizontal center of the crop window)
 *     vCenter = 0.5                    (symmetric vertical center)
 *     uHalf   = uSlice / (2 * uvZoom) (zoomed half-width)
 *     vHalf   = 0.5    / uvZoom       (zoomed half-height)
 *
 *   Step 3 — The geometry's selfie mirror is handled in computeGridAuv;
 *             this function returns the symmetric extents only.
 *
 * @param aspect  Video pixel aspect ratio (width / height). e.g. 16/9 ≈ 1.778
 * @param uvZoom  Zoom factor; > 1 crops inward making the subject larger.
 *                Must be >= 1. Passing 1.0 gives an un-zoomed 1:1 crop.
 * @returns CropExtents — the zoomed UV window boundaries and slice widths.
 *
 * @example
 * // Standard 16:9 webcam at 1.25× zoom (typical seated framing):
 * const crop = computeCropExtents(16 / 9, 1.25);
 * // crop.uSliceZ ≈ 0.444, crop.vSliceZ = 0.800
 */
export function computeCropExtents(aspect: number, uvZoom: number): CropExtents {
  const uSlice = 1 / aspect;             // 1:1 crop width in UV space
  const uPad   = (1 - uSlice) / 2;      // left dead band

  const uCenter = uPad + uSlice * 0.5;  // horizontal center of the crop
  const vCenter = 0.5;                   // symmetric vertical center

  const uHalf = uSlice / (2 * uvZoom);  // zoomed half-width
  const vHalf = 0.5    / uvZoom;        // zoomed half-height

  const uMinZ   = uCenter - uHalf;
  const uMaxZ   = uCenter + uHalf;
  const vMinZ   = vCenter - vHalf;
  const vMaxZ   = vCenter + vHalf;
  const uSliceZ = uMaxZ - uMinZ;
  const vSliceZ = vMaxZ - vMinZ;

  return { uMinZ, uMaxZ, uSliceZ, vMinZ, vMaxZ, vSliceZ };
}

// ---------------------------------------------------------------------------
// 2. Grid cell → aUv (texture coordinate for the geometry attribute)
// ---------------------------------------------------------------------------

/**
 * Compute the aUv (raw video texture UV) for a single grid cell.
 *
 * Maps a (col, row) grid position to the raw-video UV coordinate that the
 * mosaic cell should sample from. Incorporates:
 *   - Normalized grid position (col / (gridW - 1), row / (gridH - 1))
 *   - Selfie mirror on U: u = uMaxZ - normCol * uSliceZ
 *     (right-to-left across the zoomed window so the display is un-mirrored)
 *   - V flip: v = vMinZ + (1 - normRow) * vSliceZ
 *     (row 0 = screen-bottom → large V; row gridH-1 = screen-top → small V)
 *
 * The returned [u, v] are raw video UV coordinates in [uMinZ, uMaxZ] × [vMinZ, vMaxZ].
 *
 * @param col   Column index, 0-based (0 = left screen edge).
 * @param row   Row index, 0-based (0 = bottom screen edge).
 * @param gridW Total column count. Must be >= 2.
 * @param gridH Total row count. Must be >= 2.
 * @param crop  Zoomed crop extents from computeCropExtents().
 * @returns [u, v] raw-video UV for this cell's aUv attribute.
 *
 * @example
 * const crop = computeCropExtents(16 / 9, 1.25);
 * const [u, v] = computeGridAuv(0, 0, 64, 64, crop);
 * // Bottom-left cell: u = uMaxZ (mirrored right edge), v = vMaxZ (bottom of crop)
 */
export function computeGridAuv(
  col: number,
  row: number,
  gridW: number,
  gridH: number,
  crop: CropExtents,
): [u: number, v: number] {
  const normCol = col / (gridW - 1);
  const normRow = row / (gridH - 1);

  // V flip: row 0 (screen-bottom, lower chest) → vMaxZ (large V, top of raw video flipped)
  const v = crop.vMinZ + (1 - normRow) * crop.vSliceZ;

  // Selfie mirror: U runs right-to-left across the zoomed window so the
  // displayed image is not mirror-flipped from the viewer's perspective.
  const u = crop.uMaxZ - normCol * crop.uSliceZ;

  return [u, v];
}

// ---------------------------------------------------------------------------
// 3. MediaPipe landmark → mosaic world-space (for hand deform)
// ---------------------------------------------------------------------------

/**
 * Convert a single MediaPipe hand/pose landmark to mosaic world-space (x, y).
 *
 * World space: origin at canvas centre, units = CSS pixels (ortho zoom=1),
 * X increases rightward, Y increases upward.
 *
 * Transform chain (mirrors the geometry build math exactly):
 *   1. Selfie mirror:  xScreen = 1 - xMp
 *   2. Crop U:         uCrop = (xScreen - uMinZ) / uSliceZ
 *   3. Crop V:         vCrop = (yMp     - vMinZ) / vSliceZ
 *   4. World X:        wx = (uCrop - 0.5) * squarePx
 *   5. World Y:        wy = (0.5 - vCrop) * squarePx   ← V flips (row 0 = bottom)
 *
 * squarePx is the side length of the square canvas in CSS pixels.
 *
 * @param xMp      MediaPipe normalized X in [0, 1], unmirrored, origin left.
 * @param yMp      MediaPipe normalized Y in [0, 1], origin top.
 * @param crop     Zoomed crop extents from computeCropExtents().
 * @param squarePx Canvas side length in CSS pixels (min(width, height)).
 * @returns [wx, wy] mosaic world-space coordinates.
 *
 * @example
 * // A hand landmark at the horizontal centre, top quarter of frame:
 * const crop = computeCropExtents(16 / 9, 1.25);
 * const [wx, wy] = landmarkToWorld(0.5, 0.25, crop, 600);
 */
export function landmarkToWorld(
  xMp: number,
  yMp: number,
  crop: CropExtents,
  squarePx: number,
): [wx: number, wy: number] {
  const xScreen = 1 - xMp;                             // 1. selfie mirror
  const uCrop   = (xScreen - crop.uMinZ) / crop.uSliceZ; // 2. crop U
  const vCrop   = (yMp     - crop.vMinZ) / crop.vSliceZ; // 3. crop V
  const wx      = (uCrop - 0.5) * squarePx;            // 4. world X
  const wy      = (0.5 - vCrop) * squarePx;            // 5. world Y (V flipped)
  return [wx, wy];
}

// ---------------------------------------------------------------------------
// 4. MediaPipe landmark → vUv-space (for face center uniform)
// ---------------------------------------------------------------------------

/**
 * Map a raw MediaPipe face-bbox center directly to vUv space.
 *
 * vUv (= aUv) is the raw video texture coordinate. It is NOT a normalised
 * [0,1] crop-space value — it IS the texture UV the cell samples from, so:
 *   vUv.x ∈ [uMinZ, uMaxZ], vUv.y ∈ [vMinZ, vMaxZ].
 *
 * Key insight (from the long comment in mosaic.tsx useFrame):
 *   The cell that DISPLAYS a given raw-video pixel (centerX, centerY) has
 *   aUv equal to (centerX, centerY) — the selfie mirror is a screen-position
 *   effect only (it determines which normCol shows the pixel) and does NOT
 *   change the value of aUv at that cell. Therefore:
 *     u_vUv = centerX   (raw video X, already in [uMinZ, uMaxZ])
 *     v_vUv = centerY   (raw video Y, already in [vMinZ, vMaxZ])
 *
 * No mirror or crop normalisation is applied here. The radius from
 * faceBboxRef is also in raw-video-UV units and can be used directly.
 *
 * @param centerX  Face bbox center X in raw MediaPipe [0,1] video-UV space.
 * @param centerY  Face bbox center Y in raw MediaPipe [0,1] video-UV space.
 * @returns [u_vUv, v_vUv] — coordinates in vUv space (pass directly to uFaceCenter).
 *
 * @example
 * const [u, v] = landmarkToVUv(faceBbox.centerX, faceBbox.centerY);
 * // u and v are ready to write into uniforms.uFaceCenter
 */
export function landmarkToVUv(
  centerX: number,
  centerY: number,
): [u_vUv: number, v_vUv: number] {
  // Raw video UV IS vUv — no transform needed beyond passing through.
  return [centerX, centerY];
}

// ---------------------------------------------------------------------------
// 5. Normalisation helper
// ---------------------------------------------------------------------------

/**
 * Linearly interpolate a value toward a target by `speed` fraction per call.
 * Standard "lerp" used for all smoothed hand/face state in useFrame.
 *
 *   result = current + (target - current) * speed
 *
 * speed = 0 → frozen; speed = 1 → instantly snaps to target.
 *
 * @param current Current value.
 * @param target  Target value to lerp toward.
 * @param speed   Fraction of remaining gap to close per call (0–1).
 * @returns New smoothed value.
 */
export function lerpScalar(current: number, target: number, speed: number): number {
  return current + (target - current) * speed;
}
