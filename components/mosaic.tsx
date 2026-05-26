"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";
import { paletteAsVector3, PALETTE_SIZE } from "@/lib/palette";

// ---------------------------------------------------------------------------
// Iter 18 — Mask sampling threshold
// ---------------------------------------------------------------------------
/**
 * Person-probability threshold for the segmentation mask.
 * Cells with mask value < MASK_THRESHOLD are treated as off-person → void.
 * 0.5 is the natural midpoint of the [0,1] confidence range; lower values
 * keep more borderline pixels as person (softer silhouette edge), higher
 * values trim more aggressively (crisper but slightly smaller silhouette).
 */
const MASK_THRESHOLD = 0.5;

/**
 * Iteration 7 — Grid density + framing tune.
 *
 * - Grid is 64×64 (GRID_W single source of truth; GRID_H derived).
 *   cellPx = squarePx / GRID_W * dpr * 1.02, keeping hard-square tiling.
 * - UV_ZOOM crops into the center of the video so a typical seated webcam
 *   framing (head near top, shoulders visible) fills ~70 % of the frame
 *   height, matching docs/visual-reference.md layout spec.
 *
 * UV crop math (16:9 → 1:1 centered square, mirrored selfie, then zoom):
 *   Step 1 — 16:9 → 1:1 crop:
 *     uSlice = 1 / aspect          (width of the 1:1 window in UV space)
 *     uPad   = (1 - uSlice) / 2   (left dead band)
 *   Step 2 — zoom (UV_ZOOM > 1 shrinks the sampled region → subject larger):
 *     For each axis the sampled half-width = 0.5 / UV_ZOOM
 *     uCenter = uPad + uSlice * 0.5   (horizontal center of the crop)
 *     vCenter = 0.5                    (vertical center)
 *     Sampled U range: [uCenter - uSlice/(2*UV_ZOOM),
 *                       uCenter + uSlice/(2*UV_ZOOM)]
 *     Sampled V range: [vCenter - 0.5/UV_ZOOM, vCenter + 0.5/UV_ZOOM]
 *   Step 3 — mirror selfie: U = uMax_zoomed - normCol * uSlice_zoomed
 *
 * Iteration 16 — Hand-driven deform.
 *   Landmark → world-space mapping (mirrors the geometry build math):
 *     1. Mirror: x_screen = 1 - x_mp  (selfie flip)
 *     2. Crop:   u_crop = (x_screen - uMinZ) / (uSliceZ)
 *                v_crop = (y_mp     - vMinZ) / (vSliceZ)
 *     3. World:  world_x = (u_crop - 0.5) * squarePx
 *                world_y = (0.5 - v_crop) * squarePx   ← V flips (row0=bottom)
 *   The resulting world_x/world_y live in the same space as the vertex
 *   position.xy, so distance comparisons in the shader are correct.
 *
 *   uHand0/1 (vec2) — smoothed world-space hand center.
 *   uHandActive0/1 (float) — eased 0→1 when hand enters, 1→0 when it leaves.
 *   uDeformRadius (float) — world-unit influence radius (~15 % of squarePx).
 *   uDeformStrength (float) — max push displacement in world units.
 */

// ---------------------------------------------------------------------------
// Shaders — inline GLSL (no extra webpack loaders needed)
// ---------------------------------------------------------------------------

const vertexShader = /* glsl */ `
  attribute vec2 aUv;

  uniform float uPointSize;   // size in physical pixels (already DPR-scaled)

  // Iter 16 — Hand deform uniforms.
  // uHand0/1: smoothed hand world-space position (same coordinate as position.xy).
  // uHandActive0/1: 0.0 = no hand / faded out, 1.0 = fully active.
  // uDeformRadius: radial falloff distance in world units.
  // uDeformStrength: maximum displacement magnitude in world units.
  uniform vec2  uHand0;
  uniform vec2  uHand1;
  uniform float uHandActive0;
  uniform float uHandActive1;
  uniform float uDeformRadius;
  uniform float uDeformStrength;

  varying vec2 vUv;

  void main() {
    vUv = aUv;

    // Iter 16 — Compute radial push displacement for each active hand.
    // Uses the XY plane (Z=0 for all vertices), so we work entirely in 2D.
    //
    // For each hand:
    //   delta = vertex.xy - hand.xy
    //   dist  = length(delta)
    //   falloff = smoothstep(uDeformRadius, 0.0, dist)
    //             → 1.0 at the hand centre, 0.0 at uDeformRadius and beyond
    //   disp  = normalize(delta) * uDeformStrength * falloff * active
    //
    // Guard: skip normalize when the vertex is exactly at the hand centre
    //   (delta == vec2(0)) to avoid NaN / division-by-zero.
    //
    // The two contributions are summed. Clamping the total prevents runaway
    // displacement from two overlapping hands blowing cells too far off-grid.

    vec3 pos = position;
    vec2 totalDisp = vec2(0.0);

    // Hand 0
    if (uHandActive0 > 0.001) {
      vec2 delta0 = pos.xy - uHand0;
      float dist0 = length(delta0);
      if (dist0 > 0.001) {
        float falloff0 = smoothstep(uDeformRadius, 0.0, dist0);
        totalDisp += normalize(delta0) * uDeformStrength * falloff0 * uHandActive0;
      }
    }

    // Hand 1
    if (uHandActive1 > 0.001) {
      vec2 delta1 = pos.xy - uHand1;
      float dist1 = length(delta1);
      if (dist1 > 0.001) {
        float falloff1 = smoothstep(uDeformRadius, 0.0, dist1);
        totalDisp += normalize(delta1) * uDeformStrength * falloff1 * uHandActive1;
      }
    }

    // Clamp total displacement to 2× strength so two overlapping hands
    // can't push a cell more than twice the intended maximum.
    float dispLen = length(totalDisp);
    if (dispLen > uDeformStrength * 2.0) {
      totalDisp = totalDisp / dispLen * uDeformStrength * 2.0;
    }

    pos.xy += totalDisp;

    // Iter 16 (optional): slightly enlarge point near the hand for emphasis.
    // activeBlend is 0 at rest, peaks near 1 when close to an active hand.
    float activeBlend = 0.0;
    if (uHandActive0 > 0.001) {
      float dist0 = length(pos.xy - uHand0);
      activeBlend = max(activeBlend, smoothstep(uDeformRadius, 0.0, dist0) * uHandActive0);
    }
    if (uHandActive1 > 0.001) {
      float dist1 = length(pos.xy - uHand1);
      activeBlend = max(activeBlend, smoothstep(uDeformRadius, 0.0, dist1) * uHandActive1);
    }

    // position.xy are already in world units matching the ortho camera's
    // visible range [-half, +half]; z=0 keeps points on the near plane.
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = uPointSize * (1.0 + 0.35 * activeBlend);
    // NOTE (iter 7 trigger): the WebGL spec allows drivers to clamp
    // gl_PointSize at ALIASED_POINT_SIZE_RANGE[1], typically 64–1024 px.
    // If increasing grid density causes cells to shrink below the driver
    // clamp (visible as all points collapsing to the minimum size), switch
    // to InstancedMesh quads (PLAN.md iter 7 fallback) — InstancedMesh is
    // not subject to the gl_PointSize limit.
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uVideo;
  uniform vec3  uVoidColor;       // near-black void (#0a0f0a)  iter 8
  uniform float uVoidThreshold;   // base luma threshold; below this → snap to void  iter 8/12

  // Iter 18 — Segmentation mask uniforms.
  //
  // uMask: RED/FLOAT DataTexture, 256×256. Each texel = person probability [0,1].
  //   Produced by MediaPipe selfie_segmenter in RAW (unmirrored) video space.
  //
  // uMaskActive: 0.0 = mask not ready yet (skip masking, behave as before);
  //              1.0 = mask is valid, gate off-person cells to void.
  //
  // uMaskThreshold: probability below which a cell is treated as off-person.
  //   Default 0.5 — natural midpoint of [0,1] confidence output.
  //
  // ── Coordinate alignment ─────────────────────────────────────────────────
  //   vUv (= aUv) already encodes the mirrored + cropped + zoomed UV for each
  //   mosaic cell (see UV crop math in mosaic.tsx). The mask was produced in
  //   RAW video space, which is the same space aUv is built from before the
  //   mirror/crop transform.  Sampling uMask at vUv thus reads the correct
  //   raw-space mask pixel — mask and video texture are automatically aligned
  //   because they share the same UV coordinates. No extra transform needed.
  uniform sampler2D uMask;
  uniform float     uMaskActive;
  uniform float     uMaskThreshold;
  // Iter 13 — Accent scatter.
  // uAccentAmount: probability [0,1] that a non-void cell is overridden with a
  // random accent swatch (palette indices 3..7: magenta, cyan, blue, red, amber).
  // Default ~0.12 keeps accents a clear minority (~12 % of body cells).
  uniform float uAccentAmount;
  // The five accent colors (raw sRGB, matching lib/palette.ts indices 3..7).
  // A separate array avoids re-indexing the main uPalette[] in the hot path.
  #define ACCENT_COUNT 5
  uniform vec3  uAccents[ACCENT_COUNT]; // [magenta, cyan, blue, red, amber]

  // Iter 12 — Lower-body void bias.
  // Adds a small amount to the effective void threshold for cells in the lower
  // part of the frame, so darker body shadows (especially lower chest) collapse
  // to void black more readily.
  //
  // COORDINATE NOTE (traced from aUv construction in JS):
  //   row=0 (screen-bottom, lower chest) → aUv.y = vMaxZ ≈ 0.90  (LARGE)
  //   row=63 (screen-top, face)          → aUv.y = vMinZ ≈ 0.10  (SMALL)
  // VideoTexture flipY=false: V=0 = top of video (face), V=1 = bottom (chest).
  // The (1-normRow) flip in the JS maps screen-bottom rows to high V values.
  // Therefore vUv.y is LARGE at the lower chest and SMALL at the face.
  //
  // uVoidV0 / uVoidV1 define the V window [v0, v1] in lower-chest territory
  // (both values > 0.5). The ramp t = clamp((vUv.y - v0)/(v1-v0), 0, 1),
  // and the bias applied is uVoidLowerBias * t — zero at the face, maximum
  // at the lower-chest bottom. Default window: v0=0.55, v1=0.90.
  uniform float uVoidLowerBias;  // max additional threshold at the lower chest (default 0.06)
  uniform float uVoidV0;         // V where the bias starts ramping up (default 0.55, mid-chest)
  uniform float uVoidV1;         // V where the bias reaches maximum (default 0.90, bottom crop)

  // Iter 9/10 — Palette LUT.
  // GLSL ES requires a compile-time constant for array size — use #define.
  #define PALETTE_SIZE 9
  uniform vec3  uPalette[PALETTE_SIZE]; // raw sRGB vec3 per color
  uniform int   uPaletteSize;           // always 9 for now
  uniform float uPaletteMix;            // 0.0 = iter-8 output (default); 1.0 = quantized (iter 10)

  // Iter 11 — Lime bias.
  // uLimeBias (0.0–1.0) makes mid-luma cells prefer the two green swatches:
  //   Index 1 = Acid Lime  (#c8f000)
  //   Index 2 = Toxic Green (#39ff5a)
  // The bias is applied only in the mid-luma band (tent peak ~0.40) so that
  // near-void darks and near-white brights still land on their true nearest
  // palette entry. Default 0.5 gives prominent green body without eliminating
  // accent variety.
  uniform float uLimeBias;

  varying vec2 vUv;

  // Iter 10 helper: find the nearest palette entry using luma-weighted squared
  // distance. Weighting each channel by its Rec.601 luma coefficient
  // (r*0.299, g*0.587, b*0.114) means the distance is computed in a perceptual
  // space so that skin/body tones map to the closest-feeling neon rather than
  // collapsing arbitrarily. The loop bound is the compile-time constant
  // PALETTE_SIZE — GLSL ES requires a constant upper bound.
  //
  // Iter 11 — Green bias: for mid-luma cells the effective distance to palette
  // indices 1 (Acid Lime) and 2 (Toxic Green) is reduced by a factor of
  // (1.0 - uLimeBias * midWeight), where midWeight is a tent function peaking
  // at luma ≈ 0.40. Multiplying the squared distance by a value < 1.0 makes
  // the greens appear "closer" than they really are, biasing the winner toward
  // lime for body-tone luma values while leaving dark and bright extremes free
  // to pick their true nearest swatch (accents survive because their hue
  // distance to a non-green swatch is still smaller even after the reduction).
  vec3 nearestPaletteColor(vec3 color, float luma) {
    // Luma weights (Rec.601) — same as the void-floor luma calculation.
    vec3 lumaW = vec3(0.299, 0.587, 0.114);
    vec3 wColor = color * lumaW;

    // Iter 11: tent function centered at luma 0.40, half-width 0.35.
    // Returns 0.0 outside [0.05, 0.75] and 1.0 at luma 0.40.
    // Clamp keeps it non-negative on both wings.
    float midWeight = clamp(1.0 - abs(luma - 0.40) / 0.35, 0.0, 1.0);
    // Bias multiplier applied to squared distance for the two green swatches.
    // (1.0 - bias*weight) ∈ [0.5, 1.0] when bias=0.5, so it halves the
    // effective squared distance at peak mid-luma without zeroing it out.
    float greenBias = 1.0 - uLimeBias * midWeight;

    vec3 best = uPalette[0];
    vec3 wEntry = uPalette[0] * lumaW;
    vec3 wDiff  = wColor - wEntry;
    float bestDist = dot(wDiff, wDiff);

    for (int i = 1; i < PALETTE_SIZE; i++) {
      vec3 wE = uPalette[i] * lumaW;
      vec3 wd = wColor - wE;
      float d = dot(wd, wd);
      // Iter 11: apply lime bias multiplier to green swatches (indices 1 and 2).
      // Hardcoded indices match lib/palette.ts order:
      //   1 = Acid Lime #c8f000, 2 = Toxic Green #39ff5a.
      if (i == 1 || i == 2) {
        d *= greenBias;
      }
      if (d < bestDist) {
        bestDist = d;
        best = uPalette[i];
      }
    }
    return best;
  }

  // Iter 13 — Per-cell pseudo-random hash.
  // Classic Perlin/Shadertoy hash: fract(sin(dot(cell, K)) * M).
  // cell = floor(vUv * GRID_W) gives a unique integer pair per mosaic cell;
  // the two magic constants produce well-distributed values across the grid.
  // Returns a stable float in [0, 1) for the given cell coordinate.
  float cellHash(vec2 cell) {
    return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    // Iter 6: hard square cells. We do NOT test gl_PointCoord distance so the
    // full point-sprite quad is filled — no circular masking, no discard, no
    // alpha smoothstep. Every fragment within the point gets the same sampled
    // color, producing a hard aliased square cell with no soft edges.
    //
    // Color path: tex.colorSpace = THREE.NoColorSpace → GPU samples raw bytes
    // with no Three.js color-space conversion. The video stream is natively
    // sRGB; we output it directly. The renderer output colorspace is also sRGB,
    // so there is no double-encode.
    vec4 texColor = texture2D(uVideo, vUv);

    // Iter 18 — Segmentation mask gate (runs before luma void check).
    //
    // Sample the 256×256 person-probability mask at the same UV as the video
    // texture. vUv encodes the mirrored+cropped+zoomed UV, so it reads the
    // correct mask texel for this cell (see coordinate alignment note above).
    //
    // When uMaskActive == 0.0 (mask not ready), skip masking entirely so the
    // mosaic renders as it did before iter 18 — no visual regression on load.
    //
    // When the mask says this cell is background (prob < uMaskThreshold),
    // output void black immediately without entering the luma/palette path.
    // This produces the clean bust silhouette: only person-covered cells get
    // their neon color; off-person cells collapse to the void background.
    if (uMaskActive > 0.5) {
      float maskProb = texture2D(uMask, vUv).r;
      if (maskProb < uMaskThreshold) {
        gl_FragColor = vec4(uVoidColor, 1.0);
        return;
      }
    }

    // Iter 8 — Void floor: collapse very dark cells to the exact void color so
    // background noise merges seamlessly with the scene background (#0a0f0a).
    // Luma via Rec.601 weights (GLSL r169-valid; no nonexistent functions used).
    float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));

    // Iter 12 — Effective void threshold with lower-body spatial bias.
    // vUv.y is LARGE at the lower chest (~0.90) and SMALL at the face (~0.10)
    // because row=0 (screen-bottom / lower chest) maps to aUv.y = vMaxZ ≈ 0.90
    // via the (1 - normRow) flip in the JS geometry builder, and VideoTexture
    // uses flipY=false so V increases toward the bottom of the video frame.
    // The ramp t goes from 0.0 (at or below uVoidV0, face region) to 1.0 (at or
    // above uVoidV1, lower-chest region). The additive bias is uVoidLowerBias * t:
    // zero at the face, maximum at the lower chest. This concentrates void holes
    // in the lower chest while leaving the face/shoulders unaffected.
    float t = clamp((vUv.y - uVoidV0) / (uVoidV1 - uVoidV0), 0.0, 1.0);
    float effectiveThreshold = uVoidThreshold + uVoidLowerBias * t;

    // Iter 10 — Void-first ordering: dark cells are snapped to void BEFORE the
    // palette lookup so they can never be pulled to a bright neon by the nearest-
    // color search. Only above-threshold cells enter nearestPaletteColor, where
    // all 9 palette entries (including void black at index 0) are candidates —
    // near-dark-but-above-threshold cells will naturally pick void black anyway.
    // Iter 12: use effectiveThreshold instead of raw uVoidThreshold.
    vec3 preQuantize = luma < effectiveThreshold ? uVoidColor : texColor.rgb;

    // Quantize to the nearest neon swatch (luma-weighted perceptual distance).
    // uPaletteMix = 1.0 → full quantization; = 0.0 → pass-through (iter 8 mode).
    // Iter 11: pass luma so nearestPaletteColor can apply mid-band lime bias.
    vec3 quantized = nearestPaletteColor(preQuantize, luma);
    vec3 finalRgb = mix(preQuantize, quantized, uPaletteMix);

    // Iter 13 — Accent scatter: sprinkle random accent pops over non-void cells.
    // Strategy: derive a stable per-cell coordinate from vUv, then draw two hashes
    // — one to decide IF this cell gets an accent, one to pick WHICH accent color.
    // Void cells (luma < effectiveThreshold) are left untouched.
    if (luma >= effectiveThreshold) {
      // Cell grid coordinate — integer pair, one per mosaic square.
      // float(GRID_W/GRID_H) must be a literal constant for GLSL ES.
      vec2 cell = floor(vUv * 64.0);

      // First hash: scatter probability gate.
      float h1 = cellHash(cell);
      if (h1 < uAccentAmount) {
        // Second hash (offset seed so it's independent of h1): pick accent index.
        float h2 = cellHash(cell + vec2(57.0, 31.0));
        // Map h2 uniformly onto [0, ACCENT_COUNT-1].
        int accentIdx = int(h2 * float(ACCENT_COUNT));
        // Clamp in case h2 == 1.0 exactly.
        accentIdx = accentIdx < ACCENT_COUNT ? accentIdx : ACCENT_COUNT - 1;

        // Select accent color.  GLSL ES 1.0 requires constant loop / array index;
        // use an if-chain (5 branches, trivially unrolled by the driver).
        vec3 accentColor = uAccents[0];
        if (accentIdx == 1) accentColor = uAccents[1];
        if (accentIdx == 2) accentColor = uAccents[2];
        if (accentIdx == 3) accentColor = uAccents[3];
        if (accentIdx == 4) accentColor = uAccents[4];

        finalRgb = accentColor;
      }
    }

    gl_FragColor = vec4(finalRgb, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Grid constants — single source of truth
// ---------------------------------------------------------------------------

/** Number of cells across (and down — grid is always square). 40–80 range. */
const GRID_W = 64;
/** Derived: same as GRID_W so cells are square. */
const GRID_H = GRID_W;

/**
 * UV zoom factor. > 1 samples a smaller region of the source video,
 * making the subject appear larger inside the square canvas.
 * 1.25 ≈ 25 % crop inward on each axis — a typical seated-webcam framing
 * (head+shoulders) fills ~70 % of the frame height per visual-reference.md.
 */
const UV_ZOOM = 1.25;

// ---------------------------------------------------------------------------
// Iter 16 — Hand deform tuning constants
// ---------------------------------------------------------------------------

/**
 * Landmark index to use as the hand's representative position.
 * 9 = middle-finger MCP (centre of palm), stable across poses.
 * 0 = wrist (also stable, slightly off-centre).
 */
const HAND_LANDMARK_IDX = 9;

/**
 * uDeformRadius: falloff distance in world units (CSS px in ortho space).
 * ~18 % of a 1080p canvas ≈ 195 px. Tune up/down to change influence area.
 */
const DEFORM_RADIUS_FACTOR = 0.18; // fraction of squarePx

/**
 * uDeformStrength: maximum displacement in world units.
 * ~7 % of squarePx gives a clearly visible push without blowing up the figure.
 */
const DEFORM_STRENGTH_FACTOR = 0.07; // fraction of squarePx

/**
 * Lerp speed for smoothing hand position each frame (0 = frozen, 1 = instant).
 * 0.25 at 60 fps gives ~1/4 of the lag erased per frame → smooth, not sluggish.
 */
const HAND_LERP_SPEED = 0.25;

/**
 * Lerp speed for easing uHandActive in/out when a hand appears/disappears.
 * Lower = softer fade; higher = snappier.
 */
const ACTIVE_LERP_SPEED = 0.15;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Mosaic() {
  const { videoRef, status } = useWebcamContext();

  // Iter 16: read the shared landmarks ref (single detect loop, no duplicate).
  // Iter 18: read maskTextureRef for the selfie segmentation mask.
  const { landmarksRef, maskTextureRef } = useTrackingContext();

  const { size, gl } = useThree();

  // Square side in CSS pixels (shorter axis so grid fits fully).
  const squarePx = Math.min(size.width, size.height);

  // Cell size in physical pixels (DPR-scaled so points tile without gaps).
  // The *1.02 nudge closes sub-pixel gaps that appear at some DPR values;
  // keep the factor close to 1.0 to avoid heavy overlap between cells.
  const dpr = gl.getPixelRatio();
  const cellPx = (squarePx / GRID_W) * dpr * 1.02;

  // -------------------------------------------------------------------------
  // VideoTexture
  // -------------------------------------------------------------------------
  const texture = useMemo(() => {
    const video = videoRef.current;
    if (!video || status !== "ready") return null;

    const tex = new THREE.VideoTexture(video);
    // NoColorSpace: Three.js applies no color-space conversion when sampling.
    // The video bytes are natively sRGB; the fragment shader outputs them
    // directly. This avoids the non-existent LinearTosRGB and prevents
    // double-encoding (sRGB→linear→sRGB) that would wash out colors.
    tex.colorSpace = THREE.NoColorSpace;
    // NearestFilter keeps the blocky look and avoids blurring across cells.
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  }, [videoRef, status]);

  // Dispose texture on unmount.
  useEffect(() => {
    return () => {
      texture?.dispose();
    };
  }, [texture]);

  // -------------------------------------------------------------------------
  // BufferGeometry — build once per grid size
  // -------------------------------------------------------------------------
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    const count = GRID_W * GRID_H;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);

    // The ortho camera has zoom=1, so world units == CSS pixels.
    // The grid spans squarePx × squarePx centred at origin.
    const half = squarePx / 2;
    const stepX = squarePx / GRID_W;
    const stepY = squarePx / GRID_H;

    // UV crop math: 16:9 video → centered 1:1 square, mirrored, then UV_ZOOM.
    // Placeholder aspect 16/9 — corrected once real video dimensions are known
    // (see correctUVs() below). The formula is the same in both places.
    const aspect = 16 / 9;
    const uSlice = 1 / aspect;          // width of the 1:1 crop window in UV
    const uPad   = (1 - uSlice) / 2;   // left dead band

    // Zoom: sample a 1/UV_ZOOM sub-region centered on the crop center.
    const uCenter    = uPad + uSlice * 0.5;    // horizontal center of crop
    const vCenter    = 0.5;                     // vertical center (symmetric)
    const uHalf      = uSlice / (2 * UV_ZOOM); // zoomed half-width (U axis)
    const vHalf      = 0.5 / UV_ZOOM;          // zoomed half-height (V axis)

    // Zoomed crop extents.
    const uMinZ = uCenter - uHalf;  // left edge after zoom
    const uMaxZ = uCenter + uHalf;  // right edge after zoom (mirrored start)
    const vMinZ = vCenter - vHalf;
    const vMaxZ = vCenter + vHalf;
    const uSliceZ = uMaxZ - uMinZ;
    const vSliceZ = vMaxZ - vMinZ;

    let idx = 0;
    for (let row = 0; row < GRID_H; row++) {
      for (let col = 0; col < GRID_W; col++) {
        // World position: step from bottom-left corner, centre of each cell.
        const x = -half + stepX * (col + 0.5);
        const y = -half + stepY * (row + 0.5);

        positions[idx * 3 + 0] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = 0;

        // Normalized grid coords [0, 1].
        const normCol = col / (GRID_W - 1);
        const normRow = row / (GRID_H - 1);

        // V: 0 = bottom, 1 = top (video origin at top → flip V).
        const v = vMinZ + (1 - normRow) * vSliceZ;

        // U: mirrored selfie — right-to-left across the zoomed U window.
        const u = uMaxZ - normCol * uSliceZ;

        uvs[idx * 2 + 0] = u;
        uvs[idx * 2 + 1] = v;

        idx++;
      }
    }

    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aUv", new THREE.BufferAttribute(uvs, 2));

    return geo;
  }, [squarePx]);

  // -------------------------------------------------------------------------
  // ShaderMaterial uniforms
  // -------------------------------------------------------------------------
  const uniforms = useMemo<Record<string, THREE.IUniform>>(
    () => ({
      uVideo:         { value: texture },
      uPointSize:     { value: cellPx },
      // Iter 8 — void floor uniforms.
      // uVoidColor carries the RAW sRGB bytes of #0a0f0a (10,15,10 / 255).
      // THREE.Color(hex) with ColorManagement enabled (r169 default) converts
      // the value to linear (~0.003/channel), making void cells ~13× too dark.
      // Using Vector3 with the raw byte ratios bypasses that conversion, so the
      // shader's direct output matches the scene background exactly.
      uVoidColor:     { value: new THREE.Vector3(10 / 255, 15 / 255, 10 / 255) },
      // uVoidThreshold: base luma below which a cell snaps to void.
      // Iter 12: raised from 0.12 → 0.20 so mid-dark body shadows (lower chest)
      // also collapse to void black, punching characteristic holes through the
      // figure per visual-reference.md. Keep below ~0.30 to avoid eating the
      // whole figure; the lower-body bias handles the spatial gradient.
      uVoidThreshold: { value: 0.20 },
      // Iter 12 — Lower-body void bias uniforms.
      // COORDINATE NOTE: vUv.y ≈ 0.10 = face/top, vUv.y ≈ 0.90 = lower chest.
      // uVoidLowerBias: max additional threshold added for cells at the very
      //   bottom of the frame (lower chest). Default 0.06 → effective threshold
      //   at the lower chest = 0.20 + 0.06 = 0.26, enough to punch mid-dark
      //   shadows. Raise toward 0.12 to eat more of the lower body; lower to 0.0
      //   to disable the spatial bias entirely.
      // uVoidV0 / uVoidV1: the V-coordinate ramp window. With UV_ZOOM=1.25 and
      //   a 16:9 source the zoomed V range is roughly [0.10, 0.90].
      //   v0=0.55 (mid-chest) and v1=0.90 (bottom of crop): bias ramps from zero
      //   at the mid-chest line to full at the lower chest. Face (vUv.y ≈ 0.10)
      //   is well outside this window and gets zero bias.
      uVoidLowerBias: { value: 0.06 },
      uVoidV0:        { value: 0.55 },
      uVoidV1:        { value: 0.90 },
      // Iter 9 — Palette LUT uniforms (plumbing; not visually active yet).
      // paletteAsVector3() returns raw sRGB ratios (same reasoning as uVoidColor).
      uPalette:       { value: paletteAsVector3() },
      uPaletteSize:   { value: PALETTE_SIZE },
      // Iter 10 — uPaletteMix = 1.0 activates full palette quantization.
      // Every non-void cell is snapped to its nearest neon swatch; no mid-tones.
      uPaletteMix:    { value: 1.0 },
      // Iter 11 — Lime bias: 0.0 = no bias (pure nearest-color); 1.0 = maximum
      // pull toward green swatches for mid-luma cells (may over-green everything).
      // 0.5 is the tuned default: body mass reads lime while accents survive.
      // Green swatch indices: 1 = Acid Lime (#c8f000), 2 = Toxic Green (#39ff5a)
      // — matches lib/palette.ts PALETTE_HEXES ordering.
      uLimeBias:      { value: 0.5 },
      // Iter 13 — Accent scatter uniforms.
      // uAccentAmount: probability a non-void cell becomes an accent pop.
      // 0.12 = ~12 % of body cells → minority scatter, not a uniform blob.
      uAccentAmount:  { value: 0.12 },
      // uAccents: raw sRGB vec3 for palette indices 3..7 (magenta→amber).
      // Parsed manually (same reason as uVoidColor: avoid ColorManagement shift).
      uAccents: {
        value: [
          new THREE.Vector3(0xff / 255, 0x2b / 255, 0xb5 / 255), // 3 Hot Magenta  #ff2bb5
          new THREE.Vector3(0x19 / 255, 0xe0 / 255, 0xe6 / 255), // 4 Electric Cyan #19e0e6
          new THREE.Vector3(0x21 / 255, 0x56 / 255, 0xff / 255), // 5 Cobalt Blue   #2156ff
          new THREE.Vector3(0xff / 255, 0x2a / 255, 0x2a / 255), // 6 Signal Red    #ff2a2a
          new THREE.Vector3(0xff / 255, 0x9c / 255, 0x2b / 255), // 7 Amber         #ff9c2b
        ],
      },
      // Iter 16 — Hand deform uniforms.
      // Initial positions off-screen (will be updated each frame via useFrame).
      // uHandActive0/1 start at 0.0 (inactive).
      uHand0:          { value: new THREE.Vector2(0, 0) },
      uHand1:          { value: new THREE.Vector2(0, 0) },
      uHandActive0:    { value: 0.0 },
      uHandActive1:    { value: 0.0 },
      uDeformRadius:   { value: squarePx * DEFORM_RADIUS_FACTOR },
      uDeformStrength: { value: squarePx * DEFORM_STRENGTH_FACTOR },
      // Iter 18 — Segmentation mask uniforms.
      // uMask: updated each frame in useFrame once maskTextureRef.current is set.
      // uMaskActive: 0.0 until the first mask texture is produced; then 1.0.
      //   Prevents shader from sampling an uninitialised texture.
      // uMaskThreshold: probability below which a cell is gated to void.
      uMask:           { value: null },
      uMaskActive:     { value: 0.0 },
      uMaskThreshold:  { value: MASK_THRESHOLD },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // intentionally empty — we mutate uniforms directly below
  );

  // Sync uniforms when texture or size changes.
  useEffect(() => {
    uniforms.uVideo.value = texture;
  }, [texture, uniforms]);

  useEffect(() => {
    uniforms.uPointSize.value = cellPx;
  }, [cellPx, uniforms]);

  // Sync deform radius/strength when squarePx changes (window resize).
  useEffect(() => {
    uniforms.uDeformRadius.value   = squarePx * DEFORM_RADIUS_FACTOR;
    uniforms.uDeformStrength.value = squarePx * DEFORM_STRENGTH_FACTOR;
  }, [squarePx, uniforms]);

  // -------------------------------------------------------------------------
  // Update UV attributes once real video dimensions are known.
  // -------------------------------------------------------------------------
  const pointsRef = useRef<THREE.Points>(null);
  const uvsCorrected = useRef(false);

  // Iter 16 — Store real crop extents so the hand→world mapping stays in sync.
  // These mirror the UV crop computed in correctUVs() / geometry build.
  // Initialised with the placeholder 16:9 values; updated once video is ready.
  const cropRef = useRef({
    uMinZ: 0, uMaxZ: 0, uSliceZ: 1,
    vMinZ: 0, vMaxZ: 1, vSliceZ: 1,
  });

  useEffect(() => {
    if (!texture) {
      uvsCorrected.current = false;
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    const correctUVs = () => {
      if (uvsCorrected.current) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      // Same UV_ZOOM crop math as the initial geometry build, using real aspect.
      const aspect    = vw / vh;
      const uSlice    = 1 / aspect;
      const uPad      = (1 - uSlice) / 2;
      const uCenter   = uPad + uSlice * 0.5;
      const vCenter   = 0.5;
      const uHalf     = uSlice / (2 * UV_ZOOM);
      const vHalf     = 0.5 / UV_ZOOM;
      const uMinZ     = uCenter - uHalf;
      const uMaxZ     = uCenter + uHalf;
      const vMinZ     = vCenter - vHalf;
      const vMaxZ     = vCenter + vHalf;
      const uSliceZ   = uMaxZ - uMinZ;
      const vSliceZ   = vMaxZ - vMinZ;

      // Cache crop extents for landmark mapping in useFrame.
      cropRef.current = { uMinZ, uMaxZ, uSliceZ, vMinZ, vMaxZ, vSliceZ };

      const geo = pointsRef.current?.geometry;
      if (!geo) return;
      const uvAttr = geo.attributes.aUv as THREE.BufferAttribute;

      let idx = 0;
      for (let row = 0; row < GRID_H; row++) {
        for (let col = 0; col < GRID_W; col++) {
          const normCol = col / (GRID_W - 1);
          const normRow = row / (GRID_H - 1);
          const v = vMinZ + (1 - normRow) * vSliceZ;
          const u = uMaxZ - normCol * uSliceZ;
          uvAttr.setXY(idx, u, v);
          idx++;
        }
      }
      uvAttr.needsUpdate = true;
      uvsCorrected.current = true;
    };

    if (video.videoWidth) {
      correctUVs();
    } else {
      video.addEventListener("loadedmetadata", correctUVs, { once: true });
      return () => video.removeEventListener("loadedmetadata", correctUVs);
    }
  }, [texture, videoRef]);

  // -------------------------------------------------------------------------
  // useFrame: update video texture + hand deform uniforms each frame
  // -------------------------------------------------------------------------

  // Smoothed hand world-space positions (mutable, not state — no re-render cost).
  const smoothedHand0 = useRef(new THREE.Vector2(0, 0));
  const smoothedHand1 = useRef(new THREE.Vector2(0, 0));
  const smoothedActive0 = useRef(0);
  const smoothedActive1 = useRef(0);

  useFrame(() => {
    // Keep VideoTexture up-to-date.
    if (texture) texture.needsUpdate = true;

    // ── Iter 18: segmentation mask uniform update ────────────────────────────
    // The DataTexture is allocated and updated (needsUpdate=true) in the rAF
    // callback inside use-tracking.ts. Here we only need to wire the texture
    // reference into the shader uniform and flip uMaskActive once it's ready.
    const maskTex = maskTextureRef.current;
    if (maskTex) {
      uniforms.uMask.value = maskTex;
      uniforms.uMaskActive.value = 1.0;
    }

    // ── Iter 16: hand-deform uniform update ─────────────────────────────────
    const result = landmarksRef.current;
    const hands = result?.landmarks ?? [];

    const { uMinZ, uSliceZ, vMinZ, vSliceZ } = cropRef.current;

    /**
     * Convert a single MediaPipe landmark (x_mp, y_mp ∈ [0,1], unmirrored,
     * origin top-left) into mosaic world-space (x,y) using the same transform
     * chain as the geometry build:
     *
     *   1. Mirror (selfie):  x_screen = 1 - x_mp
     *   2. Map through crop: u_crop = (x_screen - uMinZ) / uSliceZ
     *                        v_crop = (y_mp      - vMinZ) / vSliceZ
     *   3. World:            wx = (u_crop - 0.5) * squarePx
     *                        wy = (0.5 - v_crop) * squarePx
     *                            ↑ V flips because row0=screen-bottom=y<0
     *
     * squarePx is captured from the outer scope (closure over component render).
     */
    const lmToWorld = (xMp: number, yMp: number): [number, number] => {
      const xScreen = 1 - xMp;                         // 1. mirror
      const uCrop = (xScreen - uMinZ) / uSliceZ;       // 2a. crop U
      const vCrop = (yMp     - vMinZ) / vSliceZ;       // 2b. crop V
      const wx = (uCrop - 0.5) * squarePx;             // 3a. world X
      const wy = (0.5 - vCrop) * squarePx;             // 3b. world Y (V flipped)
      return [wx, wy];
    };

    // Hand 0
    if (hands.length >= 1) {
      const lm = hands[0][HAND_LANDMARK_IDX];
      if (lm) {
        const [tx, ty] = lmToWorld(lm.x, lm.y);
        // Lerp smoothed position toward the target.
        smoothedHand0.current.x += (tx - smoothedHand0.current.x) * HAND_LERP_SPEED;
        smoothedHand0.current.y += (ty - smoothedHand0.current.y) * HAND_LERP_SPEED;
      }
      // Ease active weight toward 1.
      smoothedActive0.current += (1 - smoothedActive0.current) * ACTIVE_LERP_SPEED;
    } else {
      // Hand gone: ease active weight toward 0.
      smoothedActive0.current += (0 - smoothedActive0.current) * ACTIVE_LERP_SPEED;
    }

    // Hand 1
    if (hands.length >= 2) {
      const lm = hands[1][HAND_LANDMARK_IDX];
      if (lm) {
        const [tx, ty] = lmToWorld(lm.x, lm.y);
        smoothedHand1.current.x += (tx - smoothedHand1.current.x) * HAND_LERP_SPEED;
        smoothedHand1.current.y += (ty - smoothedHand1.current.y) * HAND_LERP_SPEED;
      }
      smoothedActive1.current += (1 - smoothedActive1.current) * ACTIVE_LERP_SPEED;
    } else {
      smoothedActive1.current += (0 - smoothedActive1.current) * ACTIVE_LERP_SPEED;
    }

    // Write to shader uniforms (direct mutation, no re-render cost).
    (uniforms.uHand0.value as THREE.Vector2).copy(smoothedHand0.current);
    (uniforms.uHand1.value as THREE.Vector2).copy(smoothedHand1.current);
    uniforms.uHandActive0.value = smoothedActive0.current;
    uniforms.uHandActive1.value = smoothedActive1.current;
  });

  if (!texture) return null;

  return (
    <points ref={pointsRef} geometry={geometry}>
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        // Iter 6: hard square cells — no alpha blending that could soften edges.
        transparent={false}
        depthWrite={true}
        depthTest={true}
        // sizeAttenuation=false is the default for ShaderMaterial with
        // gl_PointSize; we handle sizing explicitly in the vertex shader.
      />
    </points>
  );
}
