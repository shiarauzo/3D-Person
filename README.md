# Glitch Portrait

An interactive webcam piece that re-renders your live silhouette as a coarse neon datamosh pixel-mosaic in real time. Your webcam feed is segmented (MediaPipe selfie segmentation), quantized to a limited neon palette, and displayed as a 64×64 square grid of hard-aliased cells. Your hands push and warp the grid as you move, motion drives glitch tearing and accent scatter, and the densest color corruption concentrates on your face — exactly the aesthetic of a corrupted, pixel-sorted bitmap portrait. The target look is specified in [`docs/visual-reference.md`](docs/visual-reference.md).

---

## What it does

- **Webcam capture** — `getUserMedia` at 720p, mirrored selfie, 1:1 crop, centered in a near-black canvas.
- **MediaPipe tracking** — three detectors run in a single rAF loop, throttled off the render thread:
  - Hand Landmarker (up to 2 hands, ~30 fps)
  - Pose Landmarker / face bbox (lite model, ~30 fps)
  - Selfie segmentation mask (confidence mask, ~18 fps)
- **Neon palette quantization** — each 64×64 mosaic cell is snapped to the nearest of 9 neon swatches (void black, acid lime, toxic green, hot magenta, electric cyan, cobalt blue, signal red, amber, bone white) using luma-weighted perceptual distance.
- **Black voids** — cells below a luma threshold, plus off-person cells from the segmentation mask, collapse to `#0a0f0a`. A lower-body spatial bias punches extra voids into the chest.
- **Lime-dominant body** — a mid-luma bias pulls body-tone cells toward acid lime / toxic green so the figure reads as the reference portrait.
- **Hand-driven deform** — hand wrist/palm landmarks (index 9, MCP) drive a radial displacement field in the vertex shader. Cells near an active hand are pushed outward.
- **Motion-reactive glitch** — hand velocity is normalized to a `[0, 1]` motion signal that scales: accent scatter probability, deform strength, tear amplitude, and pixel-sort run width. More movement = more chaos.
- **Horizontal tear bands** — hash-seeded horizontal row shifts (pixel-sort / datamosh signature). Tears snap to new positions ~4 times per second.
- **Pixel-sort streaks** — Kim Asendorf-style column-hold: bright cells within active bands drag their color laterally, producing horizontal smears.
- **Face-density region** — pose landmarks derive a face bounding circle; accent probability and per-cell chaos jumps are multiplied inside that region so the face is the noisiest part of the frame.
- **Channel-shift corruption** — per-channel UV offset (RGB chromatic split) concentrated on the face region and torn bands, before palette quantization.
- **Adaptive DPR + throttled tracking** — `drei`'s `PerformanceMonitor` steps the device-pixel-ratio up/down in 0.25 increments (floor 0.75, ceiling 2.0) to hold ~45 fps on mid-range hardware. The grid count stays fixed at 64.
- **Mono HUD** — bottom-left corner readout: `FPS`, `TRACKING ON/OFF`, `HANDS` count.
- **Live control panel** — collapsible TUNE panel with six sliders wired directly to shader uniforms.

---

## Requirements

- **Browser**: a modern browser with WebGL support and a webcam.
- **Secure context**: `getUserMedia` requires HTTPS or `localhost`. Running `bun run dev` on `http://localhost:3000` is fine. A deployed build needs HTTPS.
- **Runtime**: [Bun](https://bun.sh/) (or npm / pnpm if you prefer — the scripts are standard Next.js).
- **Node**: Node 18+ (required by Next.js 15).
- **MediaPipe assets**: WASM and model files are vendored into `public/mediapipe/` by running `bun run assets` (called automatically as `predev`/`prebuild`). The script copies WASM from `node_modules/@mediapipe/tasks-vision/wasm/` and downloads the three model files from Google Storage on first run (cached on disk; skipped on subsequent runs). The `public/mediapipe/` directory is gitignored so no large binaries are committed. At runtime the app tries local assets first; if they are absent or fail to load (e.g. fresh clone without running `assets`), it falls back transparently to the CDN URLs.

---

## Camera permission and privacy

When you click **ENABLE CAMERA** the browser's native permission prompt appears. Grant access to your webcam to start the effect.

**All processing is on-device.** MediaPipe runs entirely in the browser via WebAssembly and WebGL — no video frames are uploaded anywhere. The camera stream never leaves your machine.

If you deny permission, the gate shows a **RETRY** button and instructions to re-enable camera access in your browser settings. Closing and re-opening the tab also resets the permission prompt in most browsers.

---

## Run

```bash
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) in a modern browser, click **ENABLE CAMERA**, and grant camera permission. The glitch portrait appears as soon as the webcam stream is ready and the MediaPipe models finish loading from CDN (~2–5 seconds on a typical connection).

Other commands:

```bash
bun run build   # Production build (outputs to .next/)
bun run start   # Serve the production build
bun run lint    # ESLint via next lint
```

---

## Controls

### `H` key — toggle the TUNE panel

Press **H** (or click the **TUNE** button in the top-right corner) to show or hide the live shader control panel.

### Sliders

| Label | Key | Default | Range | Effect |
|-------|-----|---------|-------|--------|
| VOID THR | `voidThreshold` | 0.20 | 0.05 – 0.50 | Luma threshold below which cells become void black. Higher = more holes. |
| TEAR PROB | `tearProbability` | 0.25 | 0.00 – 0.80 | Fraction of horizontal bands that tear each cycle. |
| TEAR AMNT | `tearAmount` | 0.040 | 0.00 – 0.15 | Maximum horizontal UV shift magnitude for torn bands. |
| ACCENT | `accentAmount` | 0.12 | 0.00 – 0.60 | Base probability a non-void cell is replaced with a random accent color. |
| LIME BIAS | `limeBias` | 0.62 | 0.00 – 1.00 | Mid-luma pull toward acid lime / toxic green. Higher = greener body mass. |
| FACE BOOST | `faceAccentBoost` | 3.0 | 0.00 – 8.00 | Accent probability multiplier inside the face bounding circle. |

Click **RESET** (inside the panel) to restore all sliders to their defaults. Defaults are defined in [`lib/controls-defaults.ts`](lib/controls-defaults.ts).

### HUD readouts

The bottom-left **GLITCH PORTRAIT** HUD shows:

- `FPS` — render frame rate (rAF-based, updated ~3 times per second).
- `TRACKING` — `ON` when the webcam is active and tracking is running; `OFF` otherwise.
- `HANDS` — number of hands currently detected (0, 1, or 2).

### Debug landmark overlay

Set `DEBUG_HANDS = true` at the top of [`components/camera-gate.tsx`](components/camera-gate.tsx) to enable the landmark dot overlay. This draws the 21-point hand skeleton, pose face bbox, and a hand count badge over the canvas — useful for verifying MediaPipe detection quality.

---

## Aesthetic

See [`docs/visual-reference.md`](docs/visual-reference.md) for the full source-of-truth reference (the "Datamosh Pixel-Sort Portrait" target) including QA checklist.

**Palette summary:**

| Color | Hex | Role |
|-------|-----|------|
| Void Black | `#0a0f0a` | Background + holes punched through the body |
| Acid Lime | `#c8f000` | Dominant body fill (lime bias target) |
| Toxic Green | `#39ff5a` | Secondary fill / highlights |
| Hot Magenta | `#ff2bb5` | Glitch streaks + accent scatter |
| Electric Cyan | `#19e0e6` | Cool accent |
| Cobalt Blue | `#2156ff` | Shadow / recess fragments |
| Signal Red | `#ff2a2a` | Sparse hot accents |
| Amber | `#ff9c2b` | Rare warm flecks |
| Bone White | `#eef3e6` | Brightest specular pixels |

The look depends on a **limited, hard-quantized palette** slammed against a near-black ground. All cell edges are deliberately hard-aliased; no anti-aliasing anywhere in the pipeline. The densest color chaos concentrates on the face; the body mass is calmer (mostly lime). Horizontal tear bands and pixel-sort streaks reinforce the databending / corrupted-JPEG aesthetic.

---

## Project structure

```
app/
├── layout.tsx              Root layout + metadata
├── globals.css             Base styles, camera-gate + HUD + controls CSS
└── page.tsx                Provider tree (Webcam → Tracking → Controls) + page shell

components/
├── scene-loader.tsx        Client-only dynamic import wrapper for <Scene>
├── scene.tsx               R3F <Canvas> with orthographic camera + PerformanceMonitor
├── mosaic.tsx              Hero component: 64×64 Points grid, inline GLSL shaders,
│                           all MediaPipe uniforms, rAF update loop
├── camera-gate.tsx         Permission flow (idle / requesting / denied / error),
│                           hidden <video> element, DEBUG_HANDS overlay flag
├── hud.tsx                 Mono terminal HUD: FPS / TRACKING / HANDS
├── controls.tsx            Collapsible TUNE panel, 'H' key shortcut, six sliders
└── hand-debug-overlay.tsx  Landmark dot overlay (only when DEBUG_HANDS = true)

context/
├── webcam-context.tsx      WebcamProvider — shares videoRef + status across tree
├── tracking-context.tsx    TrackingProvider — single detect loop, exposes refs
└── controls-context.tsx    ControlsProvider — live slider state

hooks/
├── use-webcam.ts           getUserMedia, stream lifecycle, status state machine
└── use-tracking.ts         MediaPipe init + throttled rAF detect loop (hand/pose/seg)

lib/
├── palette.ts              9 neon swatches as hex + THREE.Vector3 helpers
├── controls-defaults.ts    Single source of truth for slider defaults + ControlValues type
└── tracking/
    └── mediapipe.ts        FilesetResolver + createTrackingHandles (CDN URLs + offline note)

docs/
└── visual-reference.md     Target aesthetic spec + QA checklist
```

Shaders are **inline GLSL** inside `components/mosaic.tsx` (vertex + fragment as template-literal strings). No webpack shader loaders needed.

---

## Tech stack

| Dependency | Version | Role |
|------------|---------|------|
| Next.js | 15.2.8 | App Router, SSR shell, dev server |
| React | 18.3 | Component model |
| React Three Fiber | 8.17 | React renderer for three.js |
| drei | 9.114 | `PerformanceMonitor` adaptive DPR |
| three | r169 (0.169) | WebGL renderer, Points geometry, DataTexture |
| @mediapipe/tasks-vision | 0.10.35 | HandLandmarker, PoseLandmarker, ImageSegmenter |
| TypeScript | 5.6 | Strict mode |
| Bun | — | Package manager + dev server runner |

---

## Tuning and extending

- **Palette colors** — edit the hex array in [`lib/palette.ts`](lib/palette.ts). The shader receives the palette as a `uniform vec3[9]` array and rebuilds the quantization automatically.
- **Slider defaults** — change values in [`lib/controls-defaults.ts`](lib/controls-defaults.ts). Both the TUNE panel and the mosaic shader uniform init read from this file, so the default visual output stays consistent.
- **Grid density** — change `GRID_W` in [`components/mosaic.tsx`](components/mosaic.tsx) (currently `64`). The valid range from the spec is 40–80 cells. Note: some GPU drivers clamp `gl_PointSize` around 64 px; if cells collapse at low densities, the fallback is to switch the geometry from `THREE.Points` to `InstancedMesh` quads (not subject to the `gl_PointSize` limit).
- **Shader effects** — the vertex and fragment shaders live as inline GLSL strings at the top of `components/mosaic.tsx`. Each iter block is clearly commented. The fragment pipeline order is: channel-split → mask gate → luma void floor → palette quantize → lime bias → accent scatter → face chaos.
- **MediaPipe models** — local and CDN URLs are constants at the top of [`lib/tracking/mediapipe.ts`](lib/tracking/mediapipe.ts). The runtime prefers local vendored assets (populated by `bun run assets`) and falls back to CDN automatically. Run `bun run assets` to refresh the vendored files after upgrading `@mediapipe/tasks-vision`.
- **Tracking frame rates** — `HAND_POSE_FPS` (30) and `SEG_FPS` (18) are constants in [`hooks/use-tracking.ts`](hooks/use-tracking.ts). Lower them to reduce CPU load on slow hardware.
