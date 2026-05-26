# PLAN — Glitched Body (Reactive Datamosh Pixel-Sort Portrait)

Build an interactive web app: webcam → MediaPipe tracking → a coarse neon pixel/particle
mosaic of the person that deforms with hand/body motion, matching
`docs/visual-reference.md`. Stack: Next.js 15 (App Router) + React Three Fiber v8 +
three r169 + `@mediapipe/tasks-vision`. Package manager: **bun**.

---

## 1. Architecture overview

### Components & data flow
```
getUserMedia (camera) ──► <video> (hidden, muted, autoplay, playsInline)
        │                      │
        │                      └─► THREE.VideoTexture  ──┐
        │                                                 │
        └─► MediaPipe runner (rAF loop, detectForVideo)   │
              ├─ HandLandmarker  → hand[] (21 pts each)    │  uniforms
              ├─ PoseLandmarker  → pose[] (33 pts)         ▼
              └─ ImageSegmenter  → personMask (R channel)  GPU shader
                       │                                   (THREE.Points / InstancedMesh)
                       └──────────► uniforms ──────────────► Mosaic render
                                                                │
                                                          <Canvas> (R3F)
                                                                │
                                                          UI overlay (mono HUD)
```

### Module map (target)
| File | Responsibility |
|------|----------------|
| `app/page.tsx` | Mount `SceneLoader`, render HUD overlay, gate on camera permission |
| `components/scene-loader.tsx` | Client-only dynamic import of scene (exists) |
| `components/scene.tsx` | `<Canvas>`, orthographic camera, background, mounts `<Mosaic/>` |
| `components/mosaic.tsx` | `THREE.Points`/`InstancedMesh` grid sampling the video texture (the hero) |
| `hooks/use-webcam.ts` | `getUserMedia`, returns `video` el + ready/permission/error state |
| `hooks/use-tracking.ts` | MediaPipe init + per-frame landmarks/mask, throttled |
| `lib/tracking/mediapipe.ts` | FilesetResolver + create HandLandmarker/PoseLandmarker/ImageSegmenter |
| `lib/palette.ts` | Quantized neon palette (lime/green/magenta/cyan/blue/red/amber/bone/void) |
| `shaders/mosaic.vert` `/.frag` | Quantize, void-threshold, tear, face-density, deform |
| `components/hud.tsx` | Mono readouts: FPS, TRACKING, controls |
| `README.md` | Setup, camera permission, controls, aesthetic, run |

### Key technical decisions
- **Render primitive:** `THREE.Points` grid (1 vertex per cell, `gl_PointSize` = cell px),
  GPU-quantized color in the fragment shader. Cheapest path to a coarse mosaic; swap to
  `InstancedMesh` quads only if hard square cells need exact edges (decide ~iter 7).
- **Camera:** orthographic, 1:1 framing; figure ~70% frame height; generous black margins.
- **Tracking cadence:** MediaPipe at ~30fps decoupled from R3F's 60fps `useFrame`; latest
  results pushed into a ref → shader uniforms. Mirror the feed (selfie) horizontally.
- **Void/face data:** segmentation mask gives body alpha (voids); pose/hand give deform
  centers; a face bbox (from pose nose/ears) drives the "densest corruption" region.

---

## 2. The 30 iterations

> Each = one focused PR, merged to main before the next. Cumulative. App stays runnable.
> "Files" lists primary touches. "QA" ties to `docs/visual-reference.md` checklist.

### Phase A — Webcam foundation (1–4)
| # | Title | Scope | Files | QA acceptance |
|---|-------|-------|-------|---------------|
| 1 | Strip baseline 3D person | Remove primitive humanoid + orbit scene; leave black `<Canvas>` + ortho cam so app still builds. | `components/scene.tsx`, delete `components/person.tsx`, `app/page.tsx` | Near-black 1:1 canvas renders; lint+build pass. |
| 2 | Webcam capture hook | `use-webcam.ts`: `getUserMedia({video})`, hidden `<video>`, ready/permission/error states. | `hooks/use-webcam.ts`, `app/page.tsx` | Browser prompts for camera; granting shows live feed in a debug `<video>`. |
| 3 | Permission gate UI | Pre-permission "ENABLE CAMERA" screen + denied/error fallback, mono styling. | `app/page.tsx`, `components/hud.tsx`, `app/globals.css` | Clear permission flow; denied state shows retry message, no crash. |
| 4 | Video → texture on a plane | `THREE.VideoTexture` mapped to a full-frame plane, mirrored (selfie), 1:1 cropped. | `components/scene.tsx`, `components/mosaic.tsx` | Live mirrored camera visible inside the WebGL canvas, centered 1:1. |

### Phase B — Mosaic grid (5–8)
| # | Title | Scope | Files | QA acceptance |
|---|-------|-------|-------|---------------|
| 5 | Points grid sampling video | Replace plane with `THREE.Points` grid (~60 wide), each point samples video UV in shader. | `components/mosaic.tsx`, `shaders/mosaic.vert`, `shaders/mosaic.frag` | Coarse blocky reconstruction of the feed; cells individually readable. |
| 6 | Square hard cells | Set `gl_PointSize` per cell, square point sprite, **no** anti-alias/smoothing. | `shaders/mosaic.frag`, `components/mosaic.tsx` | Hard, aliased square pixels — mosaic not smooth (checklist: coarse grid). |
| 7 | Grid density + framing tune | Expose `gridWidth` uniform; tune to 40–80; center figure ~70% height with black margins. | `components/mosaic.tsx`, `components/scene.tsx` | Bust-sized subject fills frame; 40–80 cells across; symmetric margins. |
| 8 | Near-black background field | Set scene bg `#0a0f0a`; ensure off-subject cells read as void. | `components/scene.tsx`, `shaders/mosaic.frag` | Background is near-black void per palette swatch. |

### Phase C — Neon palette + voids (9–13)
| # | Title | Scope | Files | QA acceptance |
|---|-------|-------|-------|---------------|
| 9 | Palette LUT | `lib/palette.ts` = 9 neon swatches as a uniform array; pass to shader. | `lib/palette.ts`, `components/mosaic.tsx`, `shaders/mosaic.frag` | Palette loaded; no visual change yet (groundwork). |
| 10 | Quantize to palette | Map each sampled color to nearest palette entry (perceptual/luma-weighted distance). | `shaders/mosaic.frag` | Image rendered only in the ~8 neon colors; no mid-tones. |
| 11 | Lime-dominant bias | Bias mid-luma skin/body toward acid lime/toxic green so body mass reads lime. | `shaders/mosaic.frag`, `lib/palette.ts` | Body mass dominated by acid lime/green (checklist: dominant lime). |
| 12 | Black-void threshold | Luma below threshold → void black; punch holes into dark body regions. | `shaders/mosaic.frag` | Black voids eaten into the body, esp. lower chest. |
| 13 | Accent scatter | Hash-based per-cell jitter sprinkling magenta/cyan/blue/red/amber accents. | `shaders/mosaic.frag` | Magenta/cyan/blue/red accents scattered against lime ground. |

### Phase D — Tracking + deform (14–20)
| # | Title | Scope | Files | QA acceptance |
|---|-------|-------|-------|---------------|
| 14 | MediaPipe bootstrap | `lib/tracking/mediapipe.ts`: FilesetResolver + create landmarkers (VIDEO mode); add dep. | `lib/tracking/mediapipe.ts`, `package.json`, `hooks/use-tracking.ts` | Models load (WASM/GPU) without console errors; init logged. |
| 15 | Hand landmarks loop | `detectForVideo` for HandLandmarker in rAF; latest 21-pt hands in a ref. | `hooks/use-tracking.ts` | Debug dots overlay tracks both hands live. |
| 16 | Hand-driven deform | Pass hand centers as uniforms; radial displacement of nearby grid cells. | `components/mosaic.tsx`, `shaders/mosaic.vert` | Mosaic cells push/warp around the moving hand — moves with user. |
| 17 | Pose landmarks | Add PoseLandmarker; expose shoulders/nose/ears for framing + face bbox. | `hooks/use-tracking.ts`, `lib/tracking/mediapipe.ts` | Pose points track head/shoulders; face bbox computed live. |
| 18 | Segmentation mask | ImageSegmenter (selfie/multiclass) → person mask texture uniform. | `hooks/use-tracking.ts`, `lib/tracking/mediapipe.ts`, `components/mosaic.tsx` | Off-person cells fully void; clean bust silhouette emerges. |
| 19 | Silhouette voids | Combine mask + luma threshold so voids honor the body outline (jagged edges OK). | `shaders/mosaic.frag` | Recognizable frontal bust: head+neck+shoulders+chest, hard edges. |
| 20 | Motion-reactive intensity | Frame-diff or hand-velocity boosts corruption/displacement on movement. | `hooks/use-tracking.ts`, `shaders/mosaic.frag` | More motion → more glitch; idle calms — visibly reactive. |

### Phase E — Glitch tearing + face density (21–24)
| # | Title | Scope | Files | QA acceptance |
|---|-------|-------|-------|---------------|
| 21 | Horizontal tear bands | Row-wise UV shift in bands (time + hash seeded) — pixel-sort signature. | `shaders/mosaic.frag`, `shaders/mosaic.vert` | Visible horizontal tear bands where rows shift. |
| 22 | Pixel-sort streaks | Threshold-driven directional smear within tear bands (Asendorf-style). | `shaders/mosaic.frag` | Streaked sorted pixels read as databending, not random noise. |
| 23 | Face-density region | Use face bbox (iter 17) to raise quantization chaos + accent density on the face. | `shaders/mosaic.frag`, `components/mosaic.tsx` | Densest color corruption on the face; calmer lime body. |
| 24 | Channel-shift corruption | Per-channel UV offset (RGB split) concentrated near face/tear bands. | `shaders/mosaic.frag` | Chromatic channel-shift artifacts reinforce datamosh look. |

### Phase F — Performance (25–27)
| # | Title | Scope | Files | QA acceptance |
|---|-------|-------|-------|---------------|
| 25 | Tracking off main thread / throttle | Move MediaPipe to Web Worker (or throttle to ~30fps) so render stays 60fps. | `hooks/use-tracking.ts`, `lib/tracking/*` (worker) | R3F holds ~60fps while tracking runs; no main-thread jank. |
| 26 | Adaptive resolution | Cap `dpr`, scale grid/segmentation res to keep frame budget; degrade gracefully. | `components/scene.tsx`, `components/mosaic.tsx` | Stable fps on mid hardware; mosaic still coarse/legible. |
| 27 | Lifecycle + cleanup | Stop tracks, close landmarkers, dispose textures/geometry on unmount/tab-hide. | `hooks/use-webcam.ts`, `hooks/use-tracking.ts`, `components/mosaic.tsx` | No leaks on remount; camera light off when stopped/hidden. |

### Phase G — Polish, UI, controls (28–30)
| # | Title | Scope | Files | QA acceptance |
|---|-------|-------|-------|---------------|
| 28 | Mono HUD readouts | FPS, `TRACKING: ON/OFF`, hand count — Geist/IBM Plex Mono, low-opacity, out of figure space. | `components/hud.tsx`, `app/globals.css` | Minimal terminal-style HUD; doesn't crowd the bust. |
| 29 | Live controls | Sliders/keys for grid density, void threshold, tear amount, palette intensity. | `components/hud.tsx`, `components/mosaic.tsx` | Controls tune the look live without reload. |
| 30 | Aesthetic final tune | Calibrate palette/threshold/tear/face-density side-by-side with reference image. | `lib/palette.ts`, `shaders/mosaic.frag`, `components/mosaic.tsx` | Full QA checklist in `visual-reference.md` passes. |

---

## 3. Iteration 31 — README & docs final pass
Review/rewrite `README.md` to fully document: prerequisites (bun, Node, browser),
**camera permission** flow & privacy note (all processing on-device, no upload), how to
run (`bun install`, `bun run dev`), build/lint, the **controls** (iter 28–29), and the
**aesthetic** (link `docs/visual-reference.md`). `README.md`. QA: a new dev can clone,
grant camera, and see the glitched bust from the README alone.

---

## 4. Definition of done (per iteration)
- `bun run lint` and `bun run build` both pass.
- The render looks **closer to the target image** than the previous iteration (no regressions on already-passing checklist items).
- The app still **runs** and the figure **moves in real time** with the user's webcam.
- Change is self-contained and merged to `main` before starting the next iteration.

---

## 5. QA review notes (incorporated)
Verdict on this plan: **PASS**. All 7 visual-reference checklist items are covered. Apply
these refinements during the relevant iterations:
- **Iter 14 (MediaPipe):** default `FilesetResolver` fetches WASM/models from CDN — fine on
  localhost. If a restricted/offline target is needed, copy assets into `public/` and point
  the resolver there. Confirm CDN vs. local at this step.
- **Iter 11 (lime bias):** tuned against the *live subject*, not the reference. QA criterion =
  "visually dominant lime on the test subject"; final match deferred to iter 30 calibration.
- **Iter 25 (worker):** most re-architecture-heavy PR (OffscreenCanvas/ImageBitmap transfer).
  Correctly deferred until the pipeline works; throttle-to-30fps is the acceptable fallback.
- **Iters 6–7 (point size):** some GPUs clamp `gl_PointSize` (~64px). If large cells at low
  grid counts clip, that is the explicit trigger to switch to the `InstancedMesh` fallback.
