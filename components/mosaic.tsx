"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";
import { useControlsContext } from "@/context/controls-context";
import { paletteAsVector3, PALETTE_SIZE } from "@/lib/palette";
import { CONTROLS_DEFAULTS } from "@/lib/controls-defaults";
import vertexShader from "@/shaders/mosaic.vert";
import fragmentShader from "@/shaders/mosaic.frag";

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
// Shaders — extracted to shaders/mosaic.vert.ts and shaders/mosaic.frag.ts.
// vertexShader and fragmentShader are imported at the top of this file.
// Run `bun run validate:glsl` to statically check for banned identifiers.
// ---------------------------------------------------------------------------

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
