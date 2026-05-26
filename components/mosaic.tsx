"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";
import { useControlsContext } from "@/context/controls-context";
import { paletteAsVector3, PALETTE_SIZE } from "@/lib/palette";
import { CONTROLS_DEFAULTS } from "@/lib/controls-defaults";

// ---------------------------------------------------------------------------
// Iter 18 — Mask sampling threshold
// Iter 19 — Hard silhouette + mask-gamma tightening
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
 * Iter 19 — Mask gamma for silhouette tightening.
 * Applied as pow(maskProb, MASK_GAMMA) before the threshold comparison.
 *   = 1.0 → no change (identity)
 *   > 1.0 → suppresses low-confidence edge pixels → tighter, slightly
 *            smaller silhouette (harder/more aggressive edge trim)
 *   < 1.0 → expands borderline pixels into person territory (looser edge)
 * Range 0.8–2.0 is practical; default 1.0 is safe/neutral.
 */
const MASK_GAMMA = 1.0;

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

  // Iter 20 — Motion-reactive intensity.
  // uMotion: normalized motion signal [0, 1] derived from hand velocity.
  // uMotionDeformBoost: multiplier headroom for deform strength at peak motion.
  //   effectiveStrength = uDeformStrength * (1 + uMotion * uMotionDeformBoost)
  //   At motion=0: effectiveStrength == uDeformStrength (iter-19 baseline).
  //   At motion=1: effectiveStrength == uDeformStrength * (1 + boost).
  uniform float uMotion;
  uniform float uMotionDeformBoost; // default 0.6 → up to 60% extra warp

  varying vec2 vUv;

  void main() {
    vUv = aUv;

    // Iter 20 — Scale effective deform strength by motion signal.
    // At idle (uMotion=0) this is identical to iter-19 behaviour.
    float effectiveStrength = uDeformStrength * (1.0 + uMotion * uMotionDeformBoost);

    // Iter 16 — Compute radial push displacement for each active hand.
    // Uses the XY plane (Z=0 for all vertices), so we work entirely in 2D.
    //
    // For each hand:
    //   delta = vertex.xy - hand.xy
    //   dist  = length(delta)
    //   falloff = smoothstep(uDeformRadius, 0.0, dist)
    //             → 1.0 at the hand centre, 0.0 at uDeformRadius and beyond
    //   disp  = normalize(delta) * effectiveStrength * falloff * active
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
        totalDisp += normalize(delta0) * effectiveStrength * falloff0 * uHandActive0;
      }
    }

    // Hand 1
    if (uHandActive1 > 0.001) {
      vec2 delta1 = pos.xy - uHand1;
      float dist1 = length(delta1);
      if (dist1 > 0.001) {
        float falloff1 = smoothstep(uDeformRadius, 0.0, dist1);
        totalDisp += normalize(delta1) * effectiveStrength * falloff1 * uHandActive1;
      }
    }

    // Clamp total displacement to 2× effectiveStrength so two overlapping hands
    // can't push a cell more than twice the intended maximum.
    float dispLen = length(totalDisp);
    if (dispLen > effectiveStrength * 2.0) {
      totalDisp = totalDisp / dispLen * effectiveStrength * 2.0;
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
  uniform vec3  uVoidColor;       // near-black void (#0a0f0a)  iter 8
  uniform float uVoidThreshold;   // base luma threshold; below this → snap to void  iter 8/12

  // Iter 21 — Horizontal tear bands (pixel-sort / datamosh signature).
  // uTime:            elapsed seconds (updated every frame in useFrame).
  // uTearBands:       number of horizontal band rows (~24-40).
  // uTearProbability: fraction of bands that actually tear (~0.20-0.35).
  // uTearAmount:      maximum horizontal UV shift magnitude (~0.02-0.06).
  //
  // The tear is purely in the fragment stage: BEFORE any mask sample we
  // compute a per-band U offset and apply it to a new tearUv.  uMask is
  // sampled from tearUv so the silhouette gate travels with the shift.
  // The shift is constant across the whole band (no smoothstep) → blocky.
  // Tear amplitude is scaled by uMotion so movement drives more tearing.
  uniform float uTime;
  uniform float uTearBands;
  uniform float uTearProbability;
  uniform float uTearAmount;

  // Iter 18 — Segmentation mask uniforms.
  // Iter 19 — uMaskGamma for silhouette tightening (hard-step only, no smoothing).
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
  // uMaskGamma: iter 19 — exponent applied to maskProb before threshold
  //   comparison: pow(maskProb, uMaskGamma). 1.0 = identity (no change).
  //   Values > 1 suppress borderline edge pixels (tighter silhouette).
  //   Values < 1 expand borderline pixels (looser silhouette).
  //   This ONLY adjusts which side of the threshold a pixel falls on —
  //   the final decision is always a HARD STEP (no smoothstep, no alpha).
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
  uniform float     uMaskGamma;
  // Iter 20 — Motion-reactive intensity.
  // uMotion: normalized [0,1] motion signal (derived from hand velocity in JS).
  //   0.0 = idle/still → iter-19 baseline look.
  //   1.0 = fast movement → boosted accent scatter + stronger deform (vertex).
  // uMotionAccentBoost: multiplier headroom for accent probability at peak motion.
  //   effAccentAmount = uAccentAmount * (1 + uMotion * uMotionAccentBoost)
  //   Default 1.5 → up to 2.5× more accents at full motion. Capped at 0.95.
  uniform float uMotion;
  uniform float uMotionAccentBoost; // default 1.5

  // Iter 13 — Accent scatter.
  // uAccentAmount: base probability [0,1] that a non-void cell is overridden with
  // a random accent swatch (palette indices 3..7: magenta, cyan, blue, red, amber).
  // Default ~0.12 keeps accents a clear minority (~12 % of body cells) at idle.
  // Iter 20: effective amount is boosted by uMotion × uMotionAccentBoost.
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
  // The video element (MediaPipe input) has V=0 at the top (face) and V=1 at
  // the bottom (chest). The mask DataTexture shares this orientation.
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

  // V2 — Procedural neon field helpers.
  //
  // valueNoise: smooth 2D value noise from a lattice hash.
  // Samples 4 lattice corners, interpolates with smoothstep to avoid
  // block artifacts. Operates on the cell lattice so it is spatially
  // coherent at the mosaic cell scale — produces large lime blobs, not
  // TV static.
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    // Smoothstep interpolation weights.
    vec2 u = f * f * (3.0 - 2.0 * f);
    // Four lattice corners.
    float a = cellHash(i + vec2(0.0, 0.0));
    float b = cellHash(i + vec2(1.0, 0.0));
    float c = cellHash(i + vec2(0.0, 1.0));
    float d = cellHash(i + vec2(1.0, 1.0));
    // Bilinear interpolation.
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  // synthField: combine vertical body gradient + slow value-noise drift +
  // per-cell accent scatter into a single synthetic luma in [0, 1].
  //
  //   vGrad:     vertical body gradient.
  //              vUv.y is LARGE at the lower chest (~0.90) and SMALL at the
  //              face (~0.10) (same orientation as the lower-body void bias).
  //              We want the torso/chest to be calmer mid-value lime and
  //              the face (small vUv.y) to be hotter/brighter. So we INVERT
  //              vUv.y: gradient = 1 - vUv.y → face≈0.9, chest≈0.1.
  //              A smoothstep over [0.05, 0.95] keeps the range clean.
  //   nz:        low-frequency value noise driven by uTime drift.
  //              Scale ~4 means noise has correlation length ≈ 16 cells —
  //              produces coherent lime regions rather than salt-and-pepper.
  //              Drift speed 0.07 gives gentle motion at a calm idle.
  //   synthLuma: weighted blend: noise dominant (0.65) for variety, gradient
  //              secondary (0.35) for body-structure bias toward face hotness.
  //
  // Returns synthLuma in [0, 1]. Caller applies mask-edge boost separately.
  //
  // NOTE: synthField takes a 'cell' argument (integer lattice coordinate used
  // for value-noise sampling) but reads the fragment-stage varying vUv.y
  // directly for the vertical gradient — intentional. The gradient must be in
  // screen-space UV (face-at-top stays hot regardless of which lattice cell is
  // passed in), while 'cell' drives the spatially-coherent noise. Mixing the
  // two is by design, not a mistake.
  float synthField(vec2 cell) {
    // Vertical gradient: face region (small vUv.y) → high / bright/hot;
    // chest (large vUv.y) → low / calm. Reads vUv.y (screen-space V), not the
    // 'cell' param — see NOTE above.
    float vGrad = smoothstep(0.05, 0.95, 1.0 - vUv.y);

    // Low-frequency value noise: coherent blobs, slow time drift.
    // uNoiseScale controls spatial frequency; uNoiseDrift controls time speed.
    float nz = valueNoise(cell * uNoiseScale + uTime * uNoiseDrift);

    // Weighted blend: noise share = (1 - uGradientMix), gradient share = uGradientMix.
    // At default uGradientMix=0.35 this equals the prior nz*0.65 + vGrad*0.35.
    return clamp(nz * (1.0 - uGradientMix) + vGrad * uGradientMix, 0.0, 1.0);
  }

  // Iter 22 — Pixel-sort streaks (Kim Asendorf-style horizontal smear).
  //
  // uSortThreshold:  luma value above (or below) which a cell is a "sort trigger".
  //                  Cells with luma >= uSortThreshold are eligible to streak.
  //                  Default 0.55 — bright body tones trigger the sort.
  // uSortRun:        maximum run-width in UV space (fraction of full U range).
  //                  Several adjacent cells sharing the same snapped U column
  //                  → they all read the same source pixel → visible smear/drag.
  //                  Default 0.08 (~5 cells wide at 64 columns).
  // uSortAmount:     base probability [0,1] that an eligible cell actually streaks.
  //                  Keeps streaks a clear minority; motion scales it up.
  //                  Default 0.18.
  uniform float uSortThreshold;
  uniform float uSortRun;
  uniform float uSortAmount;

  // Iter 23 — Face-density region.
  //
  // uFaceCenter: face center in vUv space [0,1] (same coordinates the fragment
  //   shader uses for cell distance comparisons — no extra transform needed here).
  //   Computed in useFrame by applying the mirror + crop mapping to faceBboxRef.centerX/Y.
  // uFaceRadius: face bounding-circle radius in vUv units.
  //   Derived from faceBboxRef.radius (fraction of video height) divided by vSliceZ.
  // uFaceActive: 0.0 = no face detected (eased out), 1.0 = face fully tracked.
  // uFaceAccentBoost: extra accent probability multiplier inside the face core.
  //   effAccent_face = effAccent_body * (1 + faceFactor * uFaceAccentBoost).
  //   Default 3.0 → up to 4× body accent rate at the face center.
  // uFaceChaosBias: additional per-cell probability of a random-palette color jump
  //   inside the face region, independent of the accent path.
  //   0.0 = no chaos jump; 0.45 = ~45% of face-core cells get a rogue hue.
  //
  // faceFactor = uFaceActive * smoothstep(uFaceRadius, uFaceRadius * 0.4, dist)
  //   where dist = length(vUv - uFaceCenter).
  //   → 1.0 at the face center, falls to 0 at uFaceRadius, zero outside.
  //   The inner half (0.4× radius) is the "storm core"; the outer fringe ramps down.
  uniform vec2  uFaceCenter;
  uniform float uFaceRadius;
  uniform float uFaceActive;
  uniform float uFaceAccentBoost;
  uniform float uFaceChaosBias;

  // Iter 24 — Channel-shift corruption (RGB chromatic split).
  //
  // Per-channel UV offsets concentrate coloured fringes on the face and tear bands,
  // reinforcing the datamosh look.  The split is LOCAL, not global — calm body
  // cells receive ~0 shift; the face core and torn rows get the most displacement.
  //
  // uChannelShift:    base magnitude of the per-channel UV offset (fraction of
  //                   full UV width).  ~0.008 ≈ half a cell at 64 columns.
  //                   Combines with intensity to produce the effective offset.
  // uChannelFaceBias: weight multiplier for the face contribution to intensity.
  //                   Default 1.0 — face contributes its full faceFactor.
  //                   Raise to 2.0 to double-weight the face region.
  // uChannelTearBias: weight multiplier for the tear-band contribution.
  //                   Default 0.6 — torn bands get 60 % of the face weight.
  //
  // Effective offset:
  //   intensity = faceFactor * uChannelFaceBias
  //             + tearActive * uChannelTearBias
  //             + uMotion    * 0.15    (small global motion influence)
  //   off = uChannelShift * clamp(intensity, 0.0, 1.0)
  //   R samples at sampleUv + vec2(+off, 0.0)
  //   G samples at sampleUv                         (reference channel)
  //   B samples at sampleUv + vec2(-off, 0.0)
  //
  // The channel-split offset is snapped to whole-cell steps (quantized to the
  // grid) so the chromatic fringe stays blocky / cell-quantized — the split
  // nudges which palette swatch a cell picks rather than blending smoothly.
  //
  // Pipeline order:
  //   channel split (hash domain) → synthLuma → void gate → palette quantize → accents
  // The split therefore affects the pre-quantize synthetic color, letting it
  // shift which neon swatch wins and adding hue variety in hot zones.
  //
  // Mask decisions use tearUv (unmodified by sort or channel-split) so the
  // silhouette gate stays aligned — only the procedural color field is split.
  uniform float uChannelShift;
  uniform float uChannelFaceBias;
  uniform float uChannelTearBias;

  // V2 — PLAN-V2 issue 11: Synthetic-field tuning uniforms.
  // These promote the magic-number constants in synthField / texColor to
  // live-tunable uniforms. Defaults equal the prior hardcoded literals so
  // there is no visual change at the reset state.
  //
  // uNoiseScale:  spatial frequency multiplier for the value-noise lattice.
  //               cell * uNoiseScale + ... → smaller values = larger blobs.
  //               Range ~0.02–0.20; default 0.065.
  // uNoiseDrift:  uTime drift speed for the value noise.
  //               Lower = slower organic shift; higher = churning chaos.
  //               Range 0.0–0.3; default 0.07.
  // uGradientMix: weight of the vertical gradient in the blend.
  //               synthLuma = nz*(1-uGradientMix) + vGrad*uGradientMix.
  //               0 = all noise (uniform blob), 1 = pure gradient (no blob).
  //               Range 0.0–1.0; default 0.35.
  // uEdgeBoost:   additive boost to synthLuma at silhouette edges.
  //               synthLuma += edgeFactor * uEdgeBoost.
  //               Higher = hotter/busier rim; 0 = flat interior.
  //               Range 0.0–1.0; default 0.35.
  // uLimeMix:     mix factor from the lime base toward the per-channel luma.
  //               mix(limeBase, lumChannel, uLimeMix).
  //               0 = solid lime, 1 = raw per-channel luma (neon variety).
  //               Range 0.0–1.0; default 0.55.
  uniform float uNoiseScale;
  uniform float uNoiseDrift;
  uniform float uGradientMix;
  uniform float uEdgeBoost;
  uniform float uLimeMix;

  void main() {
    // =========================================================================
    // FRAGMENT PIPELINE ORDER (iter 19):
    //
    //  1. MASK GATE (silhouette boundary — hard-step, aliased, no smoothing)
    //     Off-person cells → void immediately; control flow exits.
    //     Graceful fallback: when mask not ready, skip gate (whole frame = person).
    //
    //  2. LUMA VOID FLOOR (internal body voids, lower-body bias)
    //     Runs ONLY for cells that passed the mask gate (i.e. inside the person).
    //     Dark / shadow pixels inside the body collapse to void black, punching
    //     characteristic holes through the figure — especially lower chest.
    //
    //  3. PALETTE QUANTIZE + LIME BIAS
    //     Non-void body cells are snapped to the nearest neon palette entry with
    //     a mid-luma lime pull (indices 1–2 get preference for mid-tone body mass).
    //
    //  4. ACCENT SCATTER
    //     A random ~12% of non-void body cells are overridden with an accent color
    //     (magenta/cyan/blue/red/amber) for glitch variety.
    // =========================================================================

    // ── Iter 21: Horizontal tear bands ───────────────────────────────────────
    // Compute a per-band U shift (pixel-sort / datamosh look).
    //
    // Band index: quantize vUv.y into uTearBands equal horizontal slices.
    //   bandIdx = floor(vUv.y * uTearBands)  →  one integer per band row.
    //
    // Time quantization: floor(uTime * 4.0) changes ~4 times/sec so bands
    //   snap to new positions occasionally without continuous smearing.
    //   At uTime fractions the band set is STABLE — bands hold position.
    //
    // Band hash: two independent hashes from (bandIdx, quantizedTime):
    //   h1 — probability gate:  tear only when h1 < uTearProbability
    //   h2 — signed direction:  shift = (h2 * 2.0 - 1.0) * maxShift
    //        mapped to [-1,+1] then scaled by uTearAmount so left/right
    //        tears are equally likely, keeping the silhouette balanced.
    //
    // Motion scaling: maxShift = uTearAmount * (1 + uMotion * 2.0) so calm
    //   scenes show subtle displacement, fast motion amplifies tearing.
    //
    // tearUv replaces vUv for ALL subsequent texture samples (video + mask)
    //   so color and mask always shift together — torn rows stay gated.
    // The U component is clamped to [0,1] to stay within valid UV space.
    float quantizedTime = floor(uTime * 4.0);
    float bandIdx       = floor(vUv.y * uTearBands);

    // Gate hash: decides if this band tears.
    float hGate = fract(sin(dot(vec2(bandIdx, quantizedTime),
                                vec2(12.9898, 78.233))) * 43758.5453);
    // Direction hash: independent seed via offset constants.
    float hDir  = fract(sin(dot(vec2(bandIdx + 100.0, quantizedTime + 37.0),
                                vec2(39.3468, 19.7317))) * 27831.9182);

    float maxShift = uTearAmount * (1.0 + uMotion * 2.0);
    float uShift   = (hGate < uTearProbability)
                       ? (hDir * 2.0 - 1.0) * maxShift
                       : 0.0;

    // tearUv: shifted U, unchanged V.  Clamp U inside [0,1] so we never
    // read outside the texture (wraps would smear background into the figure).
    vec2 tearUv = vec2(clamp(vUv.x + uShift, 0.0, 1.0), vUv.y);

    // ── Iter 22: Pixel-sort streaks ───────────────────────────────────────────
    // Approximates Kim Asendorf-style horizontal pixel sorting in the shader.
    //
    // Real pixel sort: scan a row, find runs where luma exceeds a threshold,
    // and sort (or hold) those runs so bright pixels drag rightward — producing
    // horizontal smears of repeated color. We approximate this per-cell:
    //
    //   1. Decide if this BAND should have pixel-sort activity at all.
    //      Uses the same bandIdx as the tear logic; a separate hash (hSort)
    //      gates whether this band participates. Coupling to bands keeps the
    //      streaks directionally aligned with the tear rows — cohesive look.
    //
    //   2. Within an active band, check if this CELL is eligible:
    //      Gate by a hash (hSortCell < effSortAmount) so only a minority of
    //      cells in active bands actually streak. This is independent of luma
    //      at this stage so we can sample luma cheaply from the tearUv first.
    //
    //   3. Sample luma at the current tearUv position. If luma >= uSortThreshold
    //      (bright cell — typical sort trigger for Kim Asendorf runs), apply the
    //      column-hold: snap the U coordinate to the start of a run block so
    //      several adjacent cells read the SAME source column. Run width varies
    //      per band via hRunWidth so adjacent bands have different streak lengths.
    //      This creates a blocky, hard-edged horizontal smear — exactly the
    //      "held/dragged pixel" look of pixel-sorted databending.
    //
    //   Motion scaling: effective run width and sort probability grow with
    //   uMotion so fast movement intensifies the streaking effect.
    //
    // sampleUv starts as tearUv; we may replace its X for streaked cells.
    vec2 sampleUv = tearUv;

    // Hash 1: does this band participate in pixel-sort at all?
    // Independent seed from tear-gate hash (offset constants).
    float hSort = fract(sin(dot(vec2(bandIdx + 200.0, quantizedTime + 13.0),
                                vec2(54.7391, 23.4817))) * 91734.2819);

    // Only ~40 % of bands can host streaks by default (tuned by uSortAmount gate
    // below per-cell; this band-level gate is a second layer that limits which
    // rows can ever streak, keeping effect spatially sparse).
    if (hSort < 0.4) {
      // Per-cell eligibility hash — independent of bandIdx so cells within the
      // band each get their own decision.
      vec2 cellCoord = floor(tearUv * 64.0);
      float hSortCell = cellHash(cellCoord + vec2(99.0, 11.0));

      // Motion-boosted sort probability.  At idle: base.  At full motion: ~2×.
      float effSortAmount = min(uSortAmount * (1.0 + uMotion * 1.0), 0.80);

      if (hSortCell < effSortAmount) {
        // Luma probe from the procedural field — no video read needed.
        // Use the cell at tearUv to stay coherent with the tear-shifted grid.
        vec2 probeCell = floor(tearUv * 64.0);
        float probeLuma = synthField(probeCell);

        // Threshold gate: only bright-enough cells trigger the sort run.
        if (probeLuma >= uSortThreshold) {
          // Run width: how many UV units share the same source column.
          // Varies per band via a dedicated hash so adjacent bands differ in
          // streak length — looks organic rather than uniformly banded.
          float hRunWidth = fract(sin(dot(vec2(bandIdx + 300.0, quantizedTime + 71.0),
                                          vec2(17.6421, 88.3124))) * 62841.7531);
          // Map hRunWidth [0,1] → [0.25, 1.0] of uSortRun so the shortest
          // streaks are still visibly blocky (≥ 2 cells wide at 64 cols).
          float runWidth = uSortRun * (0.25 + hRunWidth * 0.75);
          // Motion stretches the run: fast movement drags streaks longer.
          runWidth *= (1.0 + uMotion * 0.8);
          // Clamp: never wider than half the full U range (don't smear everything).
          runWidth = min(runWidth, 0.5);

          // Column-hold: snap U to the nearest run boundary.
          // All cells within [k*runWidth, (k+1)*runWidth) share the same snapped U.
          // This makes adjacent cells read the identical source column → smear.
          float snappedU = floor(tearUv.x / runWidth) * runWidth;
          // Keep snappedU inside [0, 1).
          snappedU = clamp(snappedU, 0.0, 1.0 - runWidth * 0.5);
          sampleUv.x = snappedU;
        }
      }
    }

    // ── Iter 24: face factor (pre-computed here for channel-split + accent) ───
    // faceFactor is needed both in the channel-split intensity (below) and in
    // the accent-scatter block (Step 4).  Computing it once avoids redundancy.
    // Uses the same formula as the iter-23 accent block — see that comment for
    // full coordinate rationale.
    float dist_face  = length(vUv - uFaceCenter);
    float faceFactor = uFaceActive * smoothstep(uFaceRadius, uFaceRadius * 0.4, dist_face);

    // ── Iter 24: Channel-shift RGB split ─────────────────────────────────────
    // Sample R, G, B from slightly different U positions so coloured fringes
    // appear.  The offset concentrates on:
    //   • The face region (faceFactor contribution).
    //   • Active tear bands (tearActive contribution).
    //   • A small global motion influence.
    //
    // tearActive: 1.0 when this band is torn (local uShift non-zero), 0.0 otherwise.
    float tearActive = (abs(uShift) > 0.0001) ? 1.0 : 0.0;

    float csIntensity = faceFactor * uChannelFaceBias
                      + tearActive * uChannelTearBias
                      + uMotion    * 0.15;
    csIntensity = clamp(csIntensity, 0.0, 1.0);

    // Channel-split offset: snap to whole-cell steps so the fringe stays
    // blocky (cell-quantized) rather than smooth. One cell width = 1/64.
    // off is measured in UV units; round to nearest cell boundary.
    float offRaw = uChannelShift * csIntensity;
    float cellSize = 1.0 / 64.0;
    float off = floor(offRaw / cellSize + 0.5) * cellSize;

    // V2 — Procedural channel-split: sample the synthetic field at three
    // slightly shifted cell lattice positions.  This reproduces the RGB-fringe
    // corruption on the face and tear bands without reading the video texture.
    //
    // Base cell for each channel. We shift sampleUv.x by ±off (quantized),
    // then derive the cell coordinate for that shifted UV position.
    vec2 baseCell = floor(sampleUv * 64.0);
    // Shift in cell units (off is already quantized to cell grid).
    float cellOff = off * 64.0;
    vec2 cellR = baseCell + vec2( cellOff, 0.0);
    vec2 cellG = baseCell;
    vec2 cellB = baseCell + vec2(-cellOff, 0.0);

    // Per-channel synthetic luma.
    float lumR = synthField(cellR);
    float lumG = synthField(cellG);
    float lumB = synthField(cellB);

    // Build a synthetic base color using the channel-split lumas as R/G/B
    // modulation on top of a lime-biased base (matching the palette intent).
    // Acid Lime is (200/255, 240/255, 0/255) ≈ (0.784, 0.941, 0.0).
    // We use the G-channel luma as the master synthLuma (reference channel),
    // and modulate R/B channels with their shifted lumas so the channel split
    // creates visible hue shifts near the face/tears.
    vec3 limeBase = vec3(0.784, 0.941, 0.0);
    // De-saturate toward per-channel luma so the channel split is visible.
    // uLimeMix controls how strongly each channel is pulled toward its luma
    // vs. remaining on the lime base. Default 0.55 matches the prior literal.
    vec3 texColor = vec3(
      mix(limeBase.r, lumR, uLimeMix),
      mix(limeBase.g, lumG, uLimeMix),
      mix(limeBase.b, lumB, uLimeMix)
    );

    // V2: texColor is the procedural channel-split synthetic color.
    // All downstream stages (luma, void, quantize, accents) consume it —
    // the split is pre-quantize. Hard square cells — no circular masking.

    // ── Step 1: MASK GATE ─────────────────────────────────────────────────────
    // V2 — Segmentation mask gate (silhouette boundary).
    //
    // Cold-start guard: when uMaskActive == 0.0 (mask not yet produced by
    // MediaPipe), output void immediately — NO neon flash before the mask
    // arrives. The synthetic color field would otherwise fill the full canvas.
    //
    // Once the mask is ready (uMaskActive ≥ 1.0):
    //   Sample the 256×256 person-probability mask at tearUv (tear-shifted).
    //   Apply uMaskGamma (iter 19): prob = pow(raw, uMaskGamma).
    //     gamma > 1 → tighter silhouette; gamma < 1 → looser.
    //   Hard binary step (NO smoothstep — aliased edge as per visual-reference):
    //     step(uMaskThreshold, prob) → 0.0 = off-person, 1.0 = person.
    //   Off-person cells output void and return immediately.
    if (uMaskActive < 0.5) {
      // Mask not ready yet → void everywhere (no neon flash on cold start).
      gl_FragColor = vec4(uVoidColor, 1.0);
      return;
    }

    // Mask is valid — gate off-person cells to void.
    {
      float rawProb  = texture2D(uMask, tearUv).r;
      float maskProb = pow(rawProb, uMaskGamma);
      float inPerson = step(uMaskThreshold, maskProb);
      if (inPerson < 0.5) {
        gl_FragColor = vec4(uVoidColor, 1.0);
        return;
      }
    }

    // ── Step 2: LUMA VOID FLOOR (inside-mask only) ───────────────────────────
    // V2 — Derive synthetic luma from the procedural field + mask-edge boost.
    //
    // Base synthLuma from the procedural field (noise + vertical gradient).
    // Mask-edge term: sample mask at ±1 cell to estimate a local gradient.
    //   Cells near the silhouette boundary read as edge (high edgeFactor) →
    //   boosted synthLuma → hotter/busier color at the rim, matching the
    //   visual reference's jagged neon edge. Interior body stays calm lime.
    //
    // The final synthLuma feeds the void gate and palette quantize in place of
    // the former video luma — no webcam RGB involved anywhere in this path.
    float baseSynth = synthField(cellG); // use the G-channel (reference) cell

    // Cheap mask-edge estimate: sample mask 1 cell away in each axis.
    float cellUVStep = 1.0 / 64.0;
    float mUp    = texture2D(uMask, tearUv + vec2(0.0,  cellUVStep)).r;
    float mDown  = texture2D(uMask, tearUv + vec2(0.0, -cellUVStep)).r;
    float mLeft  = texture2D(uMask, tearUv + vec2(-cellUVStep, 0.0)).r;
    float mRight = texture2D(uMask, tearUv + vec2( cellUVStep, 0.0)).r;
    // Gradient magnitude (cheap discrete approximation).
    float maskGrad = length(vec2(mRight - mLeft, mUp - mDown)) * 2.0;
    float edgeFactor = clamp(maskGrad, 0.0, 1.0);

    // Face region also reads hotter (faceFactor already computed above).
    // Boost synthLuma at edges (uEdgeBoost) and face; interior body stays mid-range for lime.
    float synthLuma = clamp(baseSynth + edgeFactor * uEdgeBoost + faceFactor * 0.25, 0.0, 1.0);

    // Keep "luma" as the canonical variable name so all downstream stages
    // (void threshold, palette quantize, accent gate) are unchanged.
    float luma = synthLuma;

    // Iter 12 — Effective void threshold with lower-body spatial bias.
    // vUv.y is LARGE at the lower chest (~0.90) and SMALL at the face (~0.10)
    // because row=0 (screen-bottom / lower chest) maps to aUv.y = vMaxZ ≈ 0.90
    // via the (1 - normRow) flip in the JS geometry builder. The video element
    // (and mask DataTexture) have V=0 at the top (face), so V increases toward
    // the bottom of the frame (chest).
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
    vec3 preQuantize = luma < effectiveThreshold ? uVoidColor : texColor;

    // ── Step 3: PALETTE QUANTIZE + LIME BIAS ─────────────────────────────────
    // Quantize to the nearest neon swatch (luma-weighted perceptual distance).
    // uPaletteMix = 1.0 → full quantization; = 0.0 → pass-through (iter 8 mode).
    // Iter 11: pass luma so nearestPaletteColor can apply mid-band lime bias.
    vec3 quantized = nearestPaletteColor(preQuantize, luma);
    vec3 finalRgb = mix(preQuantize, quantized, uPaletteMix);

    // ── Step 4: ACCENT SCATTER + FACE-DENSITY STORM (iter 23) ────────────────
    // Iter 13 — Accent scatter: sprinkle random accent pops over non-void cells.
    // Strategy: derive a stable per-cell coordinate from vUv, then draw two hashes
    // — one to decide IF this cell gets an accent, one to pick WHICH accent color.
    // Void cells (luma < effectiveThreshold) are left untouched.
    //
    // Iter 20 — Motion boost: effective accent probability is amplified by the
    // motion signal. effAccentAmount = uAccentAmount * (1 + uMotion * boost).
    // Clamped to 0.95 so the figure can never become a solid blob of accents.
    //
    // Iter 23 — Face-density region:
    //   faceFactor ∈ [0,1] — 1 at the face center, 0 outside uFaceRadius.
    //   Uses uFaceActive so it gracefully eases to 0 when no face is detected.
    //   Two effects inside the face:
    //     a) Accent boost: effAccent * (1 + faceFactor * uFaceAccentBoost).
    //        More accent color pops inside the face — the "focal storm".
    //     b) Chaos jump: a hash-gated probability (faceFactor * uFaceChaosBias)
    //        picks a fully random palette entry, breaking the lime body bias and
    //        adding intense hue chaos. Applied before the accent gate so it only
    //        fires when accent does NOT fire (two independent effects, no double-
    //        override).
    //   Body cells (faceFactor ≈ 0) are unchanged — calmer lime remains.
    if (luma >= effectiveThreshold) {
      // Cell grid coordinate — integer pair, one per mosaic square.
      // float(GRID_W/GRID_H) must be a literal constant for GLSL ES.
      vec2 cell = floor(vUv * 64.0);

      // Iter 23: face-region factor (faceFactor already computed above for
      // channel-split; reuse here so no redundant texture-coordinate math).

      // Iter 20: motion-boosted accent probability (body baseline).
      float effAccentAmount = uAccentAmount * (1.0 + uMotion * uMotionAccentBoost);
      // Iter 23: additional face boost — only inside the face region.
      // Body accent rate is NOT raised here (faceFactor ≈ 0 outside face).
      effAccentAmount = effAccentAmount * (1.0 + faceFactor * uFaceAccentBoost);
      // Cap: never fully saturate — preserve some lime body cells even at the face.
      effAccentAmount = min(effAccentAmount, 0.95);

      // Iter 23: chaos jump — random palette entry inside the face.
      // Fires before the regular accent gate so both effects are independent.
      // Uses a third hash with a different seed to keep it uncorrelated.
      float hChaos = cellHash(cell + vec2(23.0, 71.0));
      float chaosProb = faceFactor * uFaceChaosBias;
      if (hChaos < chaosProb) {
        // Pick any of the 5 accent colors (same set) as the chaos color.
        float hChaosIdx = cellHash(cell + vec2(111.0, 43.0));
        int chaosIdx = int(hChaosIdx * float(ACCENT_COUNT));
        chaosIdx = chaosIdx < ACCENT_COUNT ? chaosIdx : ACCENT_COUNT - 1;
        vec3 chaosColor = uAccents[0];
        if (chaosIdx == 1) chaosColor = uAccents[1];
        if (chaosIdx == 2) chaosColor = uAccents[2];
        if (chaosIdx == 3) chaosColor = uAccents[3];
        if (chaosIdx == 4) chaosColor = uAccents[4];
        finalRgb = chaosColor;
      } else {
        // Regular accent scatter (body + face both, but face has higher effAccentAmount).
        // First hash: scatter probability gate.
        float h1 = cellHash(cell);
        if (h1 < effAccentAmount) {
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
// Iter 20 — Motion-reactive intensity constants
// ---------------------------------------------------------------------------

/**
 * Normalisation divisor for hand speed → motion signal.
 *
 * Raw speed = sum of per-frame pixel displacement of each active hand's
 * smoothed world-space position.  We divide by MOTION_SPEED_MAX so that
 * "fast arm movement" ≈ 1.0, "slow drift" ≈ 0.1–0.3, "idle" ≈ 0.0.
 *
 * At 60 fps and squarePx ≈ 600 px, a hand moving across the whole frame in
 * ~0.5 s moves ~1200 px/s = ~20 px/frame.  LERP attenuates this by ~0.25,
 * so the smoothed position moves ~5 px/frame.  Two hands sum to ~10 px/frame.
 * MOTION_SPEED_MAX = 12.0 px → peak motion ≈ 0.8–1.0 under fast movement.
 */
const MOTION_SPEED_MAX = 12.0;

/**
 * Per-frame decay factor applied to uMotion when instantaneous speed drops.
 * 0.92 at 60 fps decays to ~0.1 in ~1.5 s — fast enough to feel responsive,
 * slow enough to avoid flickering when the hands momentarily pause.
 */
const MOTION_DECAY = 0.92;

/**
 * Maximum accent-scatter boost multiplier (sent to GLSL as uMotionAccentBoost).
 * effAccent = uAccentAmount * (1 + uMotion * 1.5)
 * At full motion: 0.12 * 2.5 = 0.30 (30 % of body cells accent).
 * Clamped in shader to 0.95 as an absolute ceiling.
 */
const MOTION_ACCENT_BOOST = 1.5;

/**
 * Maximum deform-strength boost multiplier (sent to GLSL as uMotionDeformBoost).
 * effectiveStrength = uDeformStrength * (1 + uMotion * 0.6)
 * At full motion: strength × 1.6 — noticeably more warp without flying off-grid.
 */
const MOTION_DEFORM_BOOST = 0.6;

// ---------------------------------------------------------------------------
// Iter 24 — Channel-shift RGB split constants
// ---------------------------------------------------------------------------

/**
 * uChannelShift: base per-channel UV offset magnitude in UV units.
 * ~0.008 ≈ ½ cell at 64 columns — visible coloured fringe, not a blur.
 * Keep below 0.02 to avoid the figure losing recognisability.
 */
const CHANNEL_SHIFT = 0.008;

/**
 * uChannelFaceBias: weight for faceFactor contribution to shift intensity.
 * 1.0 → full faceFactor → maximum shift at the face core.
 * Raise to 1.5–2.0 to super-concentrate on the face; lower to 0.5 to soften.
 */
const CHANNEL_FACE_BIAS = 1.0;

/**
 * uChannelTearBias: weight for tearActive contribution to shift intensity.
 * 0.6 → torn bands get 60 % of the face-core shift strength.
 * Ensures tear bands also exhibit RGB fringes, reinforcing the datamosh look.
 */
const CHANNEL_TEAR_BIAS = 0.6;

// ---------------------------------------------------------------------------
// Iter 23 — Face-density region constants
// ---------------------------------------------------------------------------

/**
 * Lerp speed for smoothing the face center position each frame.
 * Slower than hands (0.12 vs 0.25) because the face moves less and we want
 * a stable "storm" rather than a jittery one.
 */
const FACE_CENTER_LERP = 0.12;

/**
 * Lerp speed for smoothing the face radius each frame.
 * Radius changes slowly (head tilt/zoom), so a gentle lerp prevents popping.
 */
const FACE_RADIUS_LERP = 0.08;

/**
 * Lerp speed for easing uFaceActive in/out (0→1 when face appears, 1→0 when lost).
 */
const FACE_ACTIVE_LERP = 0.10;

/**
 * uFaceChaosBias: probability (additional) that a face-region cell picks a
 * fully random palette color (chaos jump) rather than the lime-biased quantize.
 * 0.0 = no extra chaos; 1.0 = all face cells get a random palette entry.
 * Default 0.45 — roughly half of face cells will exhibit color chaos.
 */
const FACE_CHAOS_BIAS = 0.45;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Mosaic() {
  const { videoRef, status } = useWebcamContext();

  // Iter 16: read the shared landmarks ref (single detect loop, no duplicate).
  // Iter 18: read maskTextureRef for the selfie segmentation mask.
  // Iter 23: read faceBboxRef for face-density region.
  const { landmarksRef, maskTextureRef, faceBboxRef } = useTrackingContext();

  // Iter 29 — Live controls context.
  const { controls } = useControlsContext();

  const { size, gl } = useThree();

  // Square side in CSS pixels (shorter axis so grid fits fully).
  const squarePx = Math.min(size.width, size.height);

  // Cell size in physical pixels (DPR-scaled so points tile without gaps).
  // The *1.02 nudge closes sub-pixel gaps that appear at some DPR values;
  // keep the factor close to 1.0 to avoid heavy overlap between cells.
  const dpr = gl.getPixelRatio();
  const cellPx = (squarePx / GRID_W) * dpr * 1.02;

  // V2: VideoTexture removed — the video element stays mounted for MediaPipe
  // segmentation/landmark input but is never uploaded to the GPU as a color
  // source. The shader uses a procedural synthetic field for all colors.

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

  // Dispose geometry on unmount / when squarePx changes and geometry is rebuilt.
  // BufferGeometry is created imperatively in useMemo; R3F only auto-disposes
  // objects it created from JSX primitives (<bufferGeometry />) — not useMemo instances.
  useEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry]);

  // -------------------------------------------------------------------------
  // ShaderMaterial uniforms
  // -------------------------------------------------------------------------
  const uniforms = useMemo<Record<string, THREE.IUniform>>(
    () => ({
      uPointSize:     { value: cellPx },
      // Iter 8 — void floor uniforms.
      // uVoidColor carries the RAW sRGB bytes of #0a0f0a (10,15,10 / 255).
      // THREE.Color(hex) with ColorManagement enabled (r169 default) converts
      // the value to linear (~0.003/channel), making void cells ~13× too dark.
      // Using Vector3 with the raw byte ratios bypasses that conversion, so the
      // shader's direct output matches the scene background exactly.
      uVoidColor:     { value: new THREE.Vector3(10 / 255, 15 / 255, 10 / 255) },
      // uVoidThreshold: base luma below which a cell snaps to void.
      // Iter 12: raised from 0.12 → 0.20. Iter 29: driven by CONTROLS_DEFAULTS.
      uVoidThreshold: { value: CONTROLS_DEFAULTS.voidThreshold },
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
      // Iter 11 — Lime bias. Iter 29: driven by CONTROLS_DEFAULTS.
      uLimeBias:      { value: CONTROLS_DEFAULTS.limeBias },
      // Iter 13 — Accent scatter. Iter 29: driven by CONTROLS_DEFAULTS.
      uAccentAmount:  { value: CONTROLS_DEFAULTS.accentAmount },
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
      // uMaskGamma (iter 19): exponent applied to raw mask prob before threshold.
      //   1.0 = identity (no change to silhouette edge).
      //   > 1.0 = tighter silhouette (suppresses low-confidence border pixels).
      //   < 1.0 = looser silhouette (admits more borderline pixels as person).
      //   DOES NOT affect edge smoothness — boundary is always a hard step.
      uMask:           { value: null },
      uMaskActive:     { value: 0.0 },
      uMaskThreshold:  { value: MASK_THRESHOLD },
      uMaskGamma:      { value: MASK_GAMMA },
      // Iter 20 — Motion-reactive intensity uniforms.
      // uMotion: smoothed [0,1] motion signal updated every frame in useFrame.
      //   At idle: 0.0 → visual output identical to iter-19 baseline.
      //   At peak: 1.0 → max accent boost + max deform boost.
      //   Updated via direct mutation (no setState, no re-render cost).
      // uMotionAccentBoost: headroom multiplier for accent probability.
      //   Matches the JS constant MOTION_ACCENT_BOOST (1.5 default).
      // uMotionDeformBoost: headroom multiplier for deform strength.
      //   Matches the JS constant MOTION_DEFORM_BOOST (0.6 default).
      uMotion:            { value: 0.0 },
      uMotionAccentBoost: { value: MOTION_ACCENT_BOOST },
      uMotionDeformBoost: { value: MOTION_DEFORM_BOOST },
      // Iter 21 — Horizontal tear-band uniforms.
      // uTime:            elapsed seconds, updated every frame.
      // uTearBands:       number of horizontal band rows.
      // uTearProbability: fraction of bands that tear (gate threshold).
      // uTearAmount:      max horizontal UV shift at idle (motion scales it up).
      uTime:            { value: 0.0 },
      uTearBands:       { value: 30.0 },
      // Iter 29: tear knobs driven by CONTROLS_DEFAULTS.
      uTearProbability: { value: CONTROLS_DEFAULTS.tearProbability },
      uTearAmount:      { value: CONTROLS_DEFAULTS.tearAmount },
      // Iter 22 — Pixel-sort streak uniforms.
      // uSortThreshold: luma above which a cell is eligible to streak (bright-run
      //   trigger, matching Asendorf light-sort behavior). Default 0.55.
      // uSortRun: maximum run width in UV space. At 64 columns, UV step per cell
      //   ≈ 1/64 ≈ 0.016; 0.08 ≈ 5 cells wide at max — clearly blocky streak.
      //   Shorter runs (~0.02) still read as a hold; longer runs (>0.12) risk
      //   smearing too much of the figure. Default 0.08.
      // uSortAmount: base probability that an eligible cell in an active band
      //   actually streaks. 0.18 → ~18 % of eligible cells → minority effect.
      //   Motion boosts this up to ~36 % at full speed (capped at 0.80 in shader).
      uSortThreshold:   { value: 0.55 },
      uSortRun:         { value: 0.08 },
      uSortAmount:      { value: 0.18 },
      // Iter 23 — Face-density region uniforms.
      // uFaceCenter: face center in vUv [0,1] space. Initial value centres the
      //   storm at a typical head position; overwritten each frame from faceBboxRef.
      // uFaceRadius: radius in vUv units. ~0.25 ≈ 25% of the frame height for a
      //   typical seated webcam framing.  Overwritten each frame.
      // uFaceActive: 0.0 until a face is detected; eased 0→1 on detection,
      //   1→0 when lost. Keeps the effect invisible until tracking confirms a face.
      // uFaceAccentBoost: accent multiplier headroom for the face core.
      //   effAccent_face = effAccent_body * (1 + faceFactor * uFaceAccentBoost).
      //   Default 3.0 → up to 4× body accent rate at the center.
      // uFaceChaosBias: additional chaos-jump probability inside the face.
      //   Default 0.45 → ~45% of face-core cells get a random-palette color jump.
      uFaceCenter:      { value: new THREE.Vector2(0.5, 0.35) },
      uFaceRadius:      { value: 0.25 },
      uFaceActive:      { value: 0.0 },
      // Iter 29: faceAccentBoost driven by CONTROLS_DEFAULTS.
      uFaceAccentBoost: { value: CONTROLS_DEFAULTS.faceAccentBoost },
      uFaceChaosBias:   { value: FACE_CHAOS_BIAS },
      // Iter 24 — Channel-shift RGB split uniforms.
      // uChannelShift:    base UV offset magnitude per channel (fraction of UV width).
      //   Default 0.008 ≈ ½ cell at 64 columns — clearly visible coloured fringe.
      // uChannelFaceBias: weight for face contribution to local shift intensity.
      //   Default 1.0 → faceFactor is used as-is (1.0 at face core → full shift).
      // uChannelTearBias: weight for tear-band contribution to local shift intensity.
      //   Default 0.6 → torn rows get 60 % of the face-core shift strength.
      uChannelShift:    { value: CHANNEL_SHIFT },
      uChannelFaceBias: { value: CHANNEL_FACE_BIAS },
      uChannelTearBias: { value: CHANNEL_TEAR_BIAS },
      // V2 — PLAN-V2 issue 11: Synthetic-field tuning uniforms.
      // Defaults sourced from CONTROLS_DEFAULTS so they exactly match the prior
      // hardcoded GLSL literals — no visual change at the reset state.
      uNoiseScale:  { value: CONTROLS_DEFAULTS.noiseScale },
      uNoiseDrift:  { value: CONTROLS_DEFAULTS.noiseDrift },
      uGradientMix: { value: CONTROLS_DEFAULTS.gradientMix },
      uEdgeBoost:   { value: CONTROLS_DEFAULTS.edgeBoost },
      uLimeMix:     { value: CONTROLS_DEFAULTS.limeMix },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // intentionally empty — we mutate uniforms directly below
  );

  useEffect(() => {
    uniforms.uPointSize.value = cellPx;
  }, [cellPx, uniforms]);

  // Sync deform radius/strength when squarePx changes (window resize).
  useEffect(() => {
    uniforms.uDeformRadius.value   = squarePx * DEFORM_RADIUS_FACTOR;
    uniforms.uDeformStrength.value = squarePx * DEFORM_STRENGTH_FACTOR;
  }, [squarePx, uniforms]);

  // Iter 29 — Sync live control values → shader uniforms.
  // Called whenever any control value changes (user-driven, infrequent).
  // deformStrength is stored as a fraction of squarePx (matching DEFORM_STRENGTH_FACTOR)
  // so the world-unit value accounts for the current canvas size.
  // Motion/face modulation still multiplies on top in useFrame — unaffected.
  useEffect(() => {
    uniforms.uVoidThreshold.value   = controls.voidThreshold;
    uniforms.uTearProbability.value = controls.tearProbability;
    uniforms.uTearAmount.value      = controls.tearAmount;
    uniforms.uAccentAmount.value    = controls.accentAmount;
    uniforms.uLimeBias.value        = controls.limeBias;
    uniforms.uDeformStrength.value  = squarePx * controls.deformStrength;
    uniforms.uFaceAccentBoost.value = controls.faceAccentBoost;
    // V2 — PLAN-V2 issue 11: sync synthetic-field knobs.
    uniforms.uNoiseScale.value  = controls.noiseScale;
    uniforms.uNoiseDrift.value  = controls.noiseDrift;
    uniforms.uGradientMix.value = controls.gradientMix;
    uniforms.uEdgeBoost.value   = controls.edgeBoost;
    uniforms.uLimeMix.value     = controls.limeMix;
  }, [controls, uniforms, squarePx]);

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
    // V2: correctUVs is pinned to webcam status instead of texture.
    // The mask + face-center alignment still depends on the crop math, so we
    // must correct UVs once the video dimensions are known (status === "ready").
    if (status !== "ready") {
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
  }, [status, videoRef]);

  // -------------------------------------------------------------------------
  // useFrame: update mask + hand deform uniforms each frame
  // -------------------------------------------------------------------------

  // Smoothed hand world-space positions (mutable, not state — no re-render cost).
  const smoothedHand0 = useRef(new THREE.Vector2(0, 0));
  const smoothedHand1 = useRef(new THREE.Vector2(0, 0));
  const smoothedActive0 = useRef(0);
  const smoothedActive1 = useRef(0);

  // Iter 23 — Smoothed face-region state (mutable refs, no re-render cost).
  // smoothedFaceCenter: face center in vUv [0,1] space, lerped each frame.
  // smoothedFaceRadius: face radius in vUv units, lerped each frame.
  // smoothedFaceActive: eased 0→1 on detection, 1→0 when lost.
  const smoothedFaceCenter = useRef(new THREE.Vector2(0.5, 0.35));
  const smoothedFaceRadius = useRef(0.25);
  const smoothedFaceActive = useRef(0);

  // Iter 20 — Motion signal state (mutable refs — no re-render cost).
  // prevSmoothed0/1: previous frame's smoothed hand position, used to compute
  // per-frame displacement (speed). Updated AFTER the lerp each frame.
  const prevSmoothed0 = useRef(new THREE.Vector2(0, 0));
  const prevSmoothed1 = useRef(new THREE.Vector2(0, 0));
  // motionRef: current smoothed motion signal [0,1].
  // Updated in-place via decay + instantaneous max strategy.
  const motionRef = useRef(0);

  useFrame(({ clock }) => {
    // V2: no VideoTexture to update — video stays MediaPipe-only input.

    // Iter 21 — Update elapsed time uniform for tear-band time quantization.
    uniforms.uTime.value = clock.getElapsedTime();

    // ── Segmentation mask uniform update ────────────────────────────────────
    // The DataTexture is allocated and updated (needsUpdate=true) in the rAF
    // callback inside use-tracking.ts. Here we wire the texture reference into
    // the shader uniform and flip uMaskActive once it's ready.
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

    // ── Iter 23: face-density region uniform update ──────────────────────────
    // Read the face bbox from the tracking context (updated by the rAF detect loop).
    // Map the RAW MediaPipe face center into vUv space.
    //
    // Key insight: vUv (= aUv) IS the raw video texture coordinate, not a
    // normalised [0,1] crop-space value.  vUv.x ∈ [uMinZ, uMaxZ],
    // vUv.y ∈ [vMinZ, vMaxZ] — both sub-ranges of [0,1] raw video UV.
    //
    // Therefore:
    //   u_vUv = centerX   (raw video X — the cell sampling centerX has vUv.x=centerX)
    //   v_vUv = centerY   (raw video Y — the cell sampling centerY has vUv.y=centerY;
    //                      the geometry's (1-normRow) V-flip keeps the display upright
    //                      so face-at-top-of-video → face-at-top-of-screen, both at
    //                      small vUv.y)
    //   r_vUv = radius    (raw video-space Euclidean distance, same scale as vUv)
    //
    // No mirror/crop normalisation is needed — those transforms determine SCREEN
    // POSITION (which normCol/normRow shows the face) but do not change the value
    // of vUv at that cell.  The earlier incorrect code normalised both axes to [0,1]
    // (lmToWorld crop-space), putting uFaceCenter in a different system from the
    // shader's vUv and causing the storm to drift off the actual face region.
    {
      const faceBbox = faceBboxRef.current;
      const { uMinZ, uSliceZ, vMinZ, vSliceZ } = cropRef.current;

      if (faceBbox && faceBbox.active && vSliceZ > 0) {
        // Mirror + crop: map RAW landmark space → vUv space.
        //
        // vUv (= aUv) is the raw video texture coordinate: vUv.x ∈ [uMinZ, uMaxZ],
        // vUv.y ∈ [vMinZ, vMaxZ].  It is NOT normalised to [0,1] — it IS the
        // texture UV the cell samples from.
        //
        // U axis: the cell displaying raw video pixel at X = centerX has
        //   vUv.x = uMaxZ - normCol * uSliceZ = centerX (since that cell is the
        //   one whose texture UV equals the face's raw video X).  The selfie mirror
        //   is a screen-position effect only — it doesn't alter vUv.x.
        //   → u_vUv = centerX  (unmirrored raw video X, already in [uMinZ, uMaxZ])
        //
        // V axis: the cell displaying raw video pixel at Y = centerY has
        //   vUv.y = vMinZ + (1 - normRow) * vSliceZ = centerY.
        //   The geometry's (1 - normRow) flip makes normRow→1 (top of screen) map
        //   to vMinZ (top of video), so the display is upright — face at top of
        //   video → face at top of screen, both at small vUv.y.
        //   → v_vUv = centerY  (raw video Y, already in [vMinZ, vMaxZ])
        //
        // This is correct because vUv IS the raw texture coordinate space.
        // Earlier code incorrectly normalised both axes to [0,1] (crop-space),
        // putting uFaceCenter in a different coordinate system from the shader's
        // vUv, causing the storm to drift off the actual face.
        //
        // Radius: faceBbox.radius is Euclidean distance in raw video space
        //   [0,1]×[0,1] (video normalised).  vUv.y is in the same space
        //   ([vMinZ, vMaxZ] ⊂ [0,1]).  Use radius directly — no vSliceZ division.
        //   (The approximation ignores the aspect-ratio difference between U and V
        //   pixel density, but for a circular influence region one scalar is fine.)
        const u_vUv = faceBbox.centerX;                    // raw video X = vUv.x
        const v_vUv = faceBbox.centerY;                    // raw video Y = vUv.y (V inversion baked in)
        const r_vUv = faceBbox.radius;                     // radius in vUv-space units (same scale)

        // Lerp smoothed face center and radius toward new values.
        smoothedFaceCenter.current.x += (u_vUv - smoothedFaceCenter.current.x) * FACE_CENTER_LERP;
        smoothedFaceCenter.current.y += (v_vUv - smoothedFaceCenter.current.y) * FACE_CENTER_LERP;
        smoothedFaceRadius.current   += (r_vUv - smoothedFaceRadius.current)   * FACE_RADIUS_LERP;

        // Ease active toward 1.
        smoothedFaceActive.current += (1 - smoothedFaceActive.current) * FACE_ACTIVE_LERP;
      } else {
        // No face: ease active toward 0 (center/radius hold at last valid values).
        smoothedFaceActive.current += (0 - smoothedFaceActive.current) * FACE_ACTIVE_LERP;
      }

      // Write face uniforms.
      (uniforms.uFaceCenter.value as THREE.Vector2).copy(smoothedFaceCenter.current);
      uniforms.uFaceRadius.value = smoothedFaceRadius.current;
      uniforms.uFaceActive.value = smoothedFaceActive.current;
    }

    // ── Iter 20: motion signal update ───────────────────────────────────────
    // Compute per-frame displacement of each hand's smoothed position relative
    // to the previous frame. Sum both hands → raw speed in world-px/frame.
    // Normalise to [0,1] via MOTION_SPEED_MAX, clamp, then apply decay strategy:
    //   motionRef = max(motionRef * MOTION_DECAY, instantaneous)
    // This ramps up instantly on movement and decays gracefully when still.
    // Note: only hands that are currently active (smoothedActive > 0.05) contribute
    // to speed — prevents ghost displacement from hands fading in/out.

    let rawSpeed = 0;

    if (smoothedActive0.current > 0.05) {
      rawSpeed += smoothedHand0.current.distanceTo(prevSmoothed0.current);
    }
    if (smoothedActive1.current > 0.05) {
      rawSpeed += smoothedHand1.current.distanceTo(prevSmoothed1.current);
    }

    // Store current smoothed positions as previous for next frame AFTER reading delta.
    prevSmoothed0.current.copy(smoothedHand0.current);
    prevSmoothed1.current.copy(smoothedHand1.current);

    const instantaneous = Math.min(rawSpeed / MOTION_SPEED_MAX, 1.0);
    // Decay existing motion, then take whichever is larger.
    motionRef.current = Math.max(motionRef.current * MOTION_DECAY, instantaneous);

    // Write to shader uniforms (direct mutation, no re-render cost).
    (uniforms.uHand0.value as THREE.Vector2).copy(smoothedHand0.current);
    (uniforms.uHand1.value as THREE.Vector2).copy(smoothedHand1.current);
    uniforms.uHandActive0.value = smoothedActive0.current;
    uniforms.uHandActive1.value = smoothedActive1.current;
    uniforms.uMotion.value      = motionRef.current;
  });

  // V2: render guard pinned to webcam status (not texture).
  // Once the webcam is ready, the mosaic renders; cold-start void is
  // handled in the fragment shader (uMaskActive < 0.5 → void everywhere).
  if (status !== "ready") return null;

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
