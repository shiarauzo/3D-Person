# PLAN-V2 — Synthetic Glitch Character (no webcam face)

> Goal: when the camera turns on, the user must **not** recognize themselves. The
> figure's *shape/pose* comes from MediaPipe (segmentation mask + pose + hands),
> but every cell's *color* is **procedurally generated neon** — never sampled
> from the live webcam RGB. Target look = `docs/visual-reference.md` v2.

---

## 1. Current vs Desired — gap analysis

### The core problem (video RGB IS the display source)
In `components/mosaic.tsx` the entire color pipeline is driven by the webcam texture:

1. `uVideo` is a `THREE.VideoTexture(video)` (line ~971), sampled three times for the
   channel split: `r/g/b = texture2D(uVideo, …)` → `texColor` (lines ~607–610).
2. `luma = dot(texColor.rgb, vec3(0.299,0.587,0.114))` (line ~679).
3. `preQuantize = luma < threshold ? void : texColor.rgb` (line ~699).
4. `nearestPaletteColor(preQuantize, luma)` snaps that **real skin/clothing color**
   to the nearest neon swatch (line ~705).
5. The pixel-sort probe also reads video luma (`probeLuma`, line ~552), and the
   void floor reads video luma — so **darkness/brightness of the actual user**
   decides where voids and streaks land.

**Result today:** the mosaic is a quantized, glitched image *of the user*. Even
though it is posterized to 9 colors, facial structure, clothing tone and lighting
survive the quantization → the user recognizes themselves. This **fails** the v2
checklist item "NO recognizable webcam image / user's face is NOT visible."

### What is already correct and must be preserved
- **Silhouette/shape** comes from `uMask` (selfie segmentation), a near-binary
  person-probability field — not recognizable as a face. Keep it; it is what makes
  the character "move with you."
- **Pose/hands/face placement**: `landmarksRef` (hand deform), `faceBboxRef`
  (`uFaceCenter`/`uFaceRadius`/`uFaceActive`) — geometric data, no RGB. Keep it.
- **Aesthetic machinery**: palette LUT, lime bias, accent scatter, tear bands,
  pixel-sort streaks, channel split, void color, hard square cells, motion signal.
  All of this is reusable — it just needs a **synthetic input field** instead of
  `texColor`.

### Desired pipeline (target)
Replace the *source signal* feeding luma/quantize/void/sort with a **procedural
field** built per cell from: a per-cell hash (`cellHash`), a vertical body gradient,
low-freq value noise, mask interior-vs-edge, and the face-region factor. The video
texture is **deleted entirely from the fragment color path** — it is no longer even
a uniform consumed for color. Segmentation mask + landmarks remain the only things
read from the camera.

### Other fidelity / correctness gaps vs the reference image
- **Grid coarseness**: reference says ~40–80 cells across the *figure*; current
  `GRID_W=64` is across the *whole square* with generous margins, so the figure is
  only ~40 cells wide — borderline OK but the cells may read slightly fine. Tunable.
- **Bust framing**: relies entirely on how the user sits; there is no compositional
  guarantee of a centered head+shoulders bust. With synthetic fill we can *shape*
  the silhouette via the mask but framing still depends on `UV_ZOOM=1.25` + user
  pose. Acceptable, but note as risk.
- **Face storm**: today the chaos/accent boost is real but rides on top of video
  color; once color is synthetic the storm must still read as "densest corruption
  on the face." Logic already exists (`faceFactor`, `uFaceChaosBias`,
  `uFaceAccentBoost`) and will transfer cleanly.
- **Leftover plumbing**: `uVideo`, `correctUVs`/UV-crop math, `texture.needsUpdate`,
  texture dispose, the pixel-sort `probeLuma` video read, and the channel-split
  `texture2D` calls all become dead once color is synthetic. Must be removed or
  repurposed (some UV math is still needed to align the **mask** sample and the
  face center, so do not delete the crop math wholesale — see Issue 4).
- **No build/lint regression**: `next.config.mjs` ignores TS/ESLint on build, so a
  green `bun run build` is necessary but not sufficient — manually verify the
  shader compiles (no GLSL ES errors) and there are no unused-uniform warnings.

---

## 2. Issues (ordered; each = one focused PR)

> Issues 1–3 achieve the "synthetic fill, no webcam face" requirement and are the
> priority. Issues 4–11 are fidelity/polish/cleanup toward the reference image.

### Issue 1 — Add a procedural neon field generator in the fragment shader
**Scope:** Introduce GLSL helpers that produce a synthetic per-cell base value
**without any `uVideo` read**: a `valueNoise(vec2)`/`hash`-based field plus a
vertical body gradient. Output a synthetic `synthLuma` and `synthColor` that feed
the existing void/quantize/accent stages in place of `texColor`/`luma`.
**Files:** `components/mosaic.tsx` (fragmentShader only).
**Approach:** Build `cell = floor(vUv * 64.0)`; compute `nz = valueNoise(cell*scale + uTime*driftSpeed)` (slow drift via existing `uTime`), combine with a vertical gradient `vGrad = smoothstep(...) ` over `vUv.y` (face→chest), and `edge` term from the mask gradient (Issue 2) so silhouette rims read hotter. `synthLuma = mix(gradient, noise, w)`; this is what later stages quantize.
**QA acceptance:** With the webcam covered/blank, the figure fill still shows full
neon variation (proves color no longer depends on video) — checklist "fill is
synthetic, not the live RGB."

### Issue 2 — Drive color/luma from the segmentation mask + procedural field, delete the video color read
**Scope:** Replace the three `texture2D(uVideo,…)` channel-split samples and the
`luma`/`preQuantize` derivation with the synthetic field from Issue 1. Mask still
gates silhouette; add a mask-interior depth term (distance from edge) to modulate
the field so the body mass reads as lime and edges/face get hotter.
**Files:** `components/mosaic.tsx` (fragmentShader), remove `uVideo` uniform usage.
**Approach:** Keep `uMask` sampling (`rawProb` at `tearUv`). Compute an edge factor
from neighboring mask taps (e.g. sample `uMask` at ±1 cell to get a cheap gradient).
`synthColor` base = lime; `nearestPaletteColor(synthColor, synthLuma)` still runs so
lime-bias + accents behave. The channel split now offsets the **procedural field's**
sample coordinates (hash domain), not the video — preserving RGB-fringe look.
**QA acceptance:** No `texture2D(uVideo` remains in the shader; figure is lime-dominant
body with hotter edges/face; silhouette still tracks the user — checklist "neon
palette dominated by acid lime," "NO recognizable webcam image."

### Issue 3 — Remove the VideoTexture from the color path (JS side) + keep video only as MediaPipe input
**Scope:** Delete the `uVideo` uniform, the `THREE.VideoTexture` creation/dispose,
and `texture.needsUpdate` from the render loop. The `<video>` element stays mounted
(MediaPipe `detectForVideo`/`segmentForVideo` still consume it) but is never turned
into a sampled texture. Gate the mosaic's render-readiness on mask availability
instead of texture.
**Files:** `components/mosaic.tsx`, possibly `components/camera-gate.tsx` (no change
to the hidden `<video>`).
**Approach:** Replace `if (!texture) return null;` with a guard on
`status === "ready"`. Keep `useFrame` updating mask/landmark/face/motion uniforms;
drop the `texture.needsUpdate` line. Keep `uTime` (now the only animation driver for
noise + tears).
**QA acceptance:** App renders the synthetic figure with the webcam LED on but the
video frame never reaches the GPU as a color source; `bun run build` is green and the
browser console shows no "uniform uVideo not found" or texture warnings.

### Issue 4 — Repurpose the UV crop math for mask alignment only (no regressions)
**Scope:** The geometry `aUv` + `correctUVs()` crop/zoom math currently aligns BOTH
the video and the mask. With video gone, confirm `aUv` still correctly samples the
mask and that `uFaceCenter` mapping in `useFrame` stays valid. Remove any comments/
constants that only referenced video sampling.
**Files:** `components/mosaic.tsx` (geometry builder, `correctUVs`, face-center block).
**Approach:** `aUv` and `cropRef` are still needed because the mask is in raw video
space and the face bbox maps through the same crop. Keep them; prune dead references
to "video texture" in comments. Verify `UV_ZOOM` still frames the silhouette as a bust.
**QA acceptance:** Silhouette and face storm remain spatially aligned with the user's
real position; moving left/right moves the figure correctly — checklist "moves with
the user's gestures."

### Issue 5 — Synthetic void floor (holes not tied to user brightness)
**Scope:** Today voids are punched where the *user is dark* (`luma < threshold`).
With synthetic luma, re-derive voids from the procedural field + lower-body bias so
black holes eat into the body (especially lower chest) independent of lighting.
**Files:** `components/mosaic.tsx` (void-floor block, `uVoidLowerBias`/`uVoidV0/V1`).
**Approach:** Keep `effectiveThreshold` and lower-chest ramp; compare against
`synthLuma` (noise-driven), so void placement is procedural + spatially biased low.
**QA acceptance:** Near-black background and black voids punched into the body,
concentrated lower-chest — checklist "black voids punched into the body."

### Issue 6 — Synthetic pixel-sort + tear bands (remove video luma probe)
**Scope:** The pixel-sort `probeLuma = texture2D(uVideo,…)` (line ~552) must be
replaced with the synthetic field's luma so streaks no longer depend on the user's
brightness. Tear bands already operate on UV only — verify they still read.
**Files:** `components/mosaic.tsx` (Iter-22 pixel-sort block).
**Approach:** Compute `probeLuma` from the procedural field at `tearUv`'s cell
instead of the video. Keep run-width/column-hold logic untouched.
**QA acceptance:** Visible horizontal pixel-sort tearing/streaks present with a blank
camera input — checklist "visible horizontal pixel-sort tearing; hard aliased edges."

### Issue 7 — Tune face-region storm for the synthetic look
**Scope:** Ensure the densest, brightest corruption lands on the face bbox now that
color is synthetic: verify `uFaceChaosBias`, `uFaceAccentBoost`, and the channel-shift
face bias still concentrate chaos at `uFaceCenter`.
**Files:** `components/mosaic.tsx` (face-storm block), maybe `lib/controls-defaults.ts`.
**Approach:** Re-balance defaults so body stays calm-lime and the face reads as a
storm (more accents + chaos jumps + higher noise amplitude inside `faceFactor`).
**QA acceptance:** Densest color corruption on the face, calmer lime body — checklist
"densest color corruption on the face."

### Issue 8 — Bust framing + grid coarseness pass
**Scope:** Verify the figure reads as a centered frontal bust occupying ~70% frame
height with a coarse square grid. Tune `UV_ZOOM` and consider `GRID_W` (e.g. 56–72)
so the figure is ~40–80 cells across.
**Files:** `components/mosaic.tsx` (`GRID_W`, `UV_ZOOM`), `lib/controls-defaults.ts`.
**Approach:** Empirically tune with a seated webcam framing; keep cells square and
hard-edged. If raising `GRID_W` shrinks `gl_PointSize` near driver clamp, note the
InstancedMesh fallback already documented in the vertex shader.
**QA acceptance:** Recognizable centered bust, coarse readable square grid — checklist
items 1 and 2.

### Issue 9 — Synthetic-fallback when no mask yet (cold-start look)
**Scope:** Before the segmenter produces its first mask (`uMaskActive=0`), today the
whole frame is treated as person and would fill with synthetic neon edge-to-edge.
Decide cold-start behavior: render void (empty) until mask ready, OR a centered
placeholder bust silhouette.
**Files:** `components/mosaic.tsx` (mask-gate block).
**Approach:** When `uMaskActive < 0.5`, output `uVoidColor` (blank field) so the user
never sees a full-screen neon rectangle on load; figure appears as the mask arrives.
**QA acceptance:** No full-frame neon flash on camera-enable; figure fades in with the
silhouette — supports "moves with the user."

### Issue 10 — Remove dead code / debug + verify build & lint
**Scope:** Delete now-unused symbols: video texture dispose effect, `uvsCorrected`
paths that only served video, `texture`-dependent guards, channel-split comments
referencing video; confirm `DEBUG_HANDS=false`; ensure no unused uniforms remain in
the `uniforms` object (e.g. `uVideo`).
**Files:** `components/mosaic.tsx`, `components/camera-gate.tsx`.
**Approach:** Grep for `uVideo`, `VideoTexture`, `texColor` and remove; run
`bun run build` and `bun run lint`.
**QA acceptance:** `bun run build` + `bun run lint` clean; no unused-uniform console
warnings; no leftover debug overlays.

### Issue 11 — Update visual-reference QA notes + controls panel for synthetic params
**Scope:** Add any new procedural knobs (noise scale, noise amplitude, drift speed,
edge-hotness) to `lib/controls-defaults.ts` + the live controls context/panel so the
synthetic look is tunable like the existing knobs.
**Files:** `lib/controls-defaults.ts`, `context/controls-context.*`, controls panel
component (whichever renders the sliders).
**Approach:** Mirror the existing pattern (single source of truth in
`CONTROLS_DEFAULTS`, synced via the `useEffect` that maps `controls.* → uniforms.*`).
**QA acceptance:** New synthetic params adjustable at runtime; defaults reproduce the
reference look; checklist re-verified end-to-end.

---

## 3. Risks & notes

- **Looking good without the video (biggest risk):** the video previously gave the
  figure internal structure (brightness variation reading as form). A pure hash field
  can look like flat noise. Mitigation: combine a **vertical body gradient** (lime
  torso → busier face), a **mask edge/interior depth term**, and **low-frequency value
  noise** so the body has large coherent lime regions, not TV static. Issues 1–2 must
  be tuned together; budget iteration time.
- **Cold start / full-frame flash:** without the mask gate the synthetic field would
  fill the entire square. Issue 9 must land alongside Issues 1–3, not after.
- **Performance:** removing the 3 video `texture2D` calls and the VideoTexture upload
  is a net *win*. `valueNoise` adds ALU but at 64×64 = 4096 points it is negligible.
  Keep noise to a few taps; avoid heavy fbm loops.
- **Coordinate fragility:** the mask + face-center alignment depends on the existing
  crop/zoom math. Do NOT delete `cropRef`/`aUv` when removing the video (Issue 4 guards
  this) or the silhouette will desync from the user's motion.
- **GLSL ES constraints:** array indices/loop bounds must stay compile-time constant
  (existing code already respects this). New noise helpers must avoid dynamic indexing.
- **Privacy framing:** the on-device note in `camera-gate.tsx` ("Processing happens
  on-device. Nothing is uploaded.") remains true and is now *stronger* — worth keeping.

---

## 4. Summary of issue list (grouped)

**A. Synthetic fill — the core requirement (do first, land together):**
1. Procedural neon field generator (GLSL helpers).
2. Drive color/luma from mask + procedural field; delete video color read.
3. Remove VideoTexture from the color path (JS); video stays MediaPipe-only input.
9. Cold-start: blank/void until mask ready (no full-frame neon flash).

**B. Fidelity to the reference image:**
4. Repurpose UV crop math for mask alignment only (no motion desync).
5. Synthetic void floor (procedural holes, lower-chest bias).
6. Synthetic pixel-sort + tear bands (drop video luma probe).
7. Tune face-region storm for the synthetic look.
8. Bust framing + grid coarseness pass.

**C. Cleanup & tunability:**
10. Remove dead video code/debug; verify build + lint.
11. Expose new synthetic params in the controls panel; finalize defaults.
