// Fragment shader for the mosaic point-cloud.
// Extracted from components/mosaic.tsx — do NOT edit the GLSL here directly;
// run `bun run validate:glsl` after any change to catch regressions.
//
// Compile-time #define constants (GLSL ES requires constant array sizes):
//   PALETTE_SIZE 9  — total palette entries (matches lib/palette.ts)
//   ACCENT_COUNT 5  — accent color count (palette indices 3..7)
//
// Both are hardcoded in the GLSL string; the matching JS-side constants
// (PALETTE_SIZE imported from lib/palette.ts, ACCENT_COUNT = 5) must stay
// in sync. No template-literal injection is used — the values are identical
// in the GLSL and in mosaic.tsx.
//
// All uniforms are documented in components/mosaic.tsx.

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

  // Improvement #2 — Fractal noise FBM.
  //
  // fbmNoise: 2-3 octave fractal Brownian motion built from valueNoise.
  //   Octave 1: amplitude 1.0, frequency 1x  — large coherent lime blobs.
  //   Octave 2: amplitude 0.5, frequency 2x  — mid-scale structure detail.
  //   Octave 3: amplitude 0.25, frequency 4x — fine grit/corruption detail.
  //             Weighted in by uNoiseOctaves [0,1]: 0 = 2-octave, 1 = 3-octave.
  //
  // The octaves share the same drift so the whole field moves coherently.
  // Output is normalised back to [0,1] by dividing by the total amplitude sum.
  float fbmNoise(vec2 cell) {
    vec2 driftedCell = cell * uNoiseScale + uTime * uNoiseDrift;
    float n  = valueNoise(driftedCell);               // octave 1
    float n2 = valueNoise(driftedCell * 2.0 + vec2(17.3, 31.7)); // octave 2
    float n3 = valueNoise(driftedCell * 4.0 + vec2(53.1, 9.8));  // octave 3
    // Base: 2-octave sum, total amplitude = 1.5.
    float base = (n + n2 * 0.5) / 1.5;
    // Cross-fade in octave 3 (amplitude 0.25) by uNoiseOctaves.
    // When fully added: total amp = 1.75, so normalise by it.
    float withThird = (n + n2 * 0.5 + n3 * 0.25) / 1.75;
    return mix(base, withThird, uNoiseOctaves);
  }

  // synthField: combine vertical body gradient + fractal value-noise drift +
  // per-cell accent scatter into a single synthetic luma in [0, 1].
  //
  //   vGrad:     vertical body gradient.
  //              vUv.y is LARGE at the lower chest (~0.90) and SMALL at the
  //              face (~0.10) (same orientation as the lower-body void bias).
  //              We want the torso/chest to be calmer mid-value lime and
  //              the face (small vUv.y) to be hotter/brighter. So we INVERT
  //              vUv.y: gradient = 1 - vUv.y → face≈0.9, chest≈0.1.
  //              A smoothstep over [0.05, 0.95] keeps the range clean.
  //   nz:        fractal FBM noise (2-3 octaves) driven by uTime drift.
  //              Produces both large coherent lime blobs AND fine detail.
  //   synthLuma: weighted blend: noise dominant (0.65) for variety, gradient
  //              secondary (0.35) for body-structure bias toward face hotness.
  //
  //   Improvement #2 — Shoulder shading:
  //   A subtle darkening band at mid-upper V (shoulder zone: vUv.y ≈ 0.30–0.50)
  //   is added to the noise term so shoulders read as a distinct horizontal
  //   band between the face and the calmer chest, consistent with the
  //   reference's tapered-neck / broad-shoulder silhouette. The band is
  //   narrow and subtle (max 0.08 luma reduction) so it does not fight the
  //   lime bias or void gate.
  //
  // Returns synthLuma in [0, 1]. Caller applies mask-edge boost + face/chest
  // structure separately.
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

    // Improvement #2 — Fractal FBM noise (2-3 octaves).
    // Replaces single-frequency valueNoise call. Adds mid/fine-scale structure.
    float nz = fbmNoise(cell);

    // Improvement #2 — Shoulder shading band.
    // Shoulder zone: vUv.y in [0.30, 0.50] (between face top and chest).
    // Tent function peaks at vUv.y=0.40 (shoulder centre) and falls to 0 at
    // the edges. Max 0.08 darkening — enough to distinguish without crushing.
    float shoulderBand = clamp(1.0 - abs(vUv.y - 0.40) / 0.10, 0.0, 1.0);
    shoulderBand = shoulderBand * shoulderBand; // soften the peak
    float shoulderDark = shoulderBand * 0.08;

    // Weighted blend: noise share = (1 - uGradientMix), gradient share = uGradientMix.
    // At default uGradientMix=0.35 this equals the prior nz*0.65 + vGrad*0.35.
    float field = nz * (1.0 - uGradientMix) + vGrad * uGradientMix;
    // Apply subtle shoulder darkening to the noise term only (not the gradient).
    field -= shoulderDark * (1.0 - uGradientMix);
    return clamp(field, 0.0, 1.0);
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

  // Improvement #2 — Body-structure uniforms.
  //
  // uFaceFeatures: [0,1] strength of procedural eye + mouth band dips carved
  //   inside the face bounding region (positioned via uFaceCenter/uFaceRadius).
  //   0 = no bands (flat face), 1 = full band depth. Default 0.55.
  //   The eye band sits ~0.25 * radius above face center; the mouth band sits
  //   ~0.35 * radius below. Both are gated by faceFactor so they move with
  //   the tracked head and vanish when no face is detected.
  //
  // uChestVoid: [0,1] strength of the sternum void-cluster punch in the lower-
  //   center chest region. At 1.0 a cluster of cells around the lower-center
  //   vUv area are forced below the void threshold (black holes), matching the
  //   reference's characteristic hollow chest. Default 0.50.
  //   Combines additively with the existing lower-body void bias so both
  //   effects cooperate. Position: lower half (vUv.y > 0.55), center-U band.
  //
  // uNoiseOctaves: [0,1] blend weight of the high-frequency octave in the
  //   fractal noise sum. The base field is always 2-octave FBM
  //   (1.0 * f1 + 0.5 * f2); uNoiseOctaves cross-fades in a third octave
  //   (0.25 * f4) for fine corrupted detail.
  //   0 = 2-octave (smooth blobs), 1 = 3-octave (fine grit added). Default 0.6.
  uniform float uFaceFeatures;
  uniform float uChestVoid;
  uniform float uNoiseOctaves;

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

    // ── Improvement #2: Face feature bands ───────────────────────────────────
    // Carve a darker EYE band and MOUTH band into the face region so the head
    // reads as a dissolving face rather than a uniform hot blob.
    //
    // Both bands are positioned relative to uFaceCenter/uFaceRadius so they
    // move with the tracked head. They are gated by faceFactor (falls to 0
    // outside the face bbox) so they vanish when no face is detected and do
    // not affect the torso.
    //
    // Eye band:   centered at uFaceCenter.y - 0.25 * uFaceRadius (above centre).
    //   Band half-height = 0.10 * uFaceRadius.  Creates a horizontal dark stripe
    //   spanning the full face width where the eyes would be.
    // Mouth band: centered at uFaceCenter.y + 0.35 * uFaceRadius (below centre).
    //   Band half-height = 0.08 * uFaceRadius.  Narrower stripe for the mouth.
    //
    // The darkness of each band is controlled by uFaceFeatures [0,1].
    // Bands darken (subtract from) synthLuma — they don't force void (that's
    // the void gate's job); they just lower luma so those cells are more likely
    // to be picked as a dark/void/black swatch.
    //
    // vUv.y coordinate: face center is provided in raw vUv space from
    // landmarkToVUv, which passes centerY straight through (vUv IS raw video
    // space; V=0 = top, V=1 = bottom).  uFaceCenter.y is therefore larger
    // for lower face positions and smaller for higher positions — consistent
    // with vUv.y conventions everywhere in this shader.
    {
      float eyeCenterV   = uFaceCenter.y - 0.25 * uFaceRadius;
      float mouthCenterV = uFaceCenter.y + 0.35 * uFaceRadius;
      float halfEye   = uFaceRadius * 0.10;
      float halfMouth = uFaceRadius * 0.08;

      // Tent functions: 1.0 at the band centre, 0.0 at the band edges.
      float eyeBand   = clamp(1.0 - abs(vUv.y - eyeCenterV)   / halfEye,   0.0, 1.0);
      float mouthBand = clamp(1.0 - abs(vUv.y - mouthCenterV) / halfMouth, 0.0, 1.0);

      // Gate by faceFactor so bands only appear on the tracked face.
      float eyeDark   = eyeBand   * faceFactor * uFaceFeatures * 0.45;
      float mouthDark = mouthBand * faceFactor * uFaceFeatures * 0.35;

      synthLuma = clamp(synthLuma - eyeDark - mouthDark, 0.0, 1.0);
    }

    // ── Improvement #2: Chest void cluster ───────────────────────────────────
    // Punch a cluster of black voids into the lower-center chest / sternum
    // region, matching the reference image's characteristic hollow holes.
    //
    // The cluster is defined by:
    //   • Lower half: vUv.y > uVoidV0 (same start as the lower-body bias ramp)
    //   • Center-U band: vUv.x within ±0.12 of 0.50
    //   • Noise gate: a fast-varying hash per cell produces a patchy cluster
    //     rather than a solid rectangle (avoids too-regular-looking geometry).
    //
    // The cluster adds to the effective void threshold in Step 2 below, which
    // means it cooperates with — and adds onto — the existing lower-body bias.
    // The noise gate is a separate hash seed so the cluster pattern is
    // independent of the accent and chaos hashes.
    //
    // uChestVoid [0,1]: 0 = no extra cluster, 1 = strong sternum black holes.
    // The cluster only activates inside the lower-center zone; outside that zone
    // the bias is exactly 0 (no effect anywhere else).
    float chestVoidBias = 0.0;
    {
      // Horizontal proximity to U=0.5: 1.0 at center, 0 at ±0.12.
      float uDist = abs(vUv.x - 0.50);
      float uBand = clamp(1.0 - uDist / 0.12, 0.0, 1.0);
      // Vertical: only below uVoidV0 (lower chest / sternum zone).
      float vStart = uVoidV0; // reuse existing lower-body bias start
      float lowerFactor = clamp((vUv.y - vStart) / (uVoidV1 - vStart), 0.0, 1.0);
      // Noise gate: patchy holes rather than a solid block.
      // Fast cell hash with a unique seed so it's uncorrelated with accents.
      vec2 chestCell = floor(vUv * 64.0);
      float chestHash = cellHash(chestCell + vec2(83.0, 127.0));
      // Only cells where hash < 0.55 are part of the cluster — ~55% fill.
      float clusterGate = step(chestHash, 0.55);
      chestVoidBias = uBand * lowerFactor * clusterGate * uChestVoid * 0.30;
    }

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
    // Improvement #2: add chest void cluster bias alongside the lower-body ramp.
    float effectiveThreshold = uVoidThreshold + uVoidLowerBias * t + chestVoidBias;

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

export default fragmentShader;
