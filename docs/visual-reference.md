# Visual Style Reference — "Glitched Body" (v2)

> Source: `a2477a52b4c5b03f4a5b116dcfdd6257.webp` — a frontal bust of a human figure
> (head, neck, shoulders, chest) rendered as a corrupted, pixel-sorted bitmap on a
> near-black field. This is the **source of truth** the QA agent compares every
> iteration against.
>
> **v2 rendering intent (READ THIS):** when the camera turns on the user must **NOT see
> their own face / webcam image**. The displayed figure is a *synthetic glitch character* —
> its silhouette/pose is driven by the user's body and gestures (MediaPipe segmentation +
> pose + hands), but the fill is **procedurally generated neon** (palette + noise +
> face-region storm), **never sampled from the live webcam RGB**. You move → the character
> moves; you never recognize yourself.

---

## 1. Core Aesthetic

- **Style name: Datamosh Pixel-Sort Portrait** (a.k.a. "glitched body / databent bust")
- **Design philosophy:** A recognizable human silhouette dissolved into a grid of
  corrupted pixels — legible as a body, visibly broken; organic form vs. digital decay.
- **Key influences / hybrid styles:** databending / glitch art, pixel sorting
  (Kim Asendorf threshold sorts), low-bit quantized dithering, CRT/teletext neon-on-black,
  generative ASCII/mosaic portraits.

## 2. Color Palette

Loud, near-fluorescent colors punched out of a black ground. ~8 dominant hues; high chroma,
almost no mid-tones (dithering jumps between extremes).

| Color | Hex (approx) | Usage context |
|-------|-------------|---------------|
| Void Black | `#0a0f0a` | Background field + "holes" punched through the body |
| Acid Lime | `#c8f000` | **Dominant** skin/body fill — the base mass of the figure |
| Toxic Green | `#39ff5a` | Secondary fill, highlights along shoulders/chest |
| Hot Magenta | `#ff2bb5` | Glitch streaks, scattered accent pixels |
| Electric Cyan | `#19e0e6` | Cool accent, neck + shoulder fragments |
| Cobalt Blue | `#2156ff` | Shadow/recess fragments, lower torso bands |
| Signal Red | `#ff2a2a` | Sparse hot accents in the face/chest |
| Amber | `#ff9c2b` | Rare warm flecks |
| Bone White | `#eef3e6` | Brightest specular pixels (very sparse) |

- **Total:** small, quantized palette (≈8–9). The look depends on *limited* colors slammed
  against each other, not smooth gradients.
- **Tension:** warm neon (lime/magenta/red) vs. cold (cyan/blue) on a desaturated black-green
  ground → maximal edge vibration.

## 3. Typography System

Source image is type-free. For the app UI: monospace, uppercase, wide letter-spacing
(terminal/teletext), low opacity (~0.5) for system readouts; minimal, kept out of the
figure's space. No serif/humanist fonts.

## 4. Key Design Elements

**Textures & treatments**
- Coarse, *visible* pixel grid — large readable cells (mosaic, not photoreal). ~40–80 cells
  wide across the figure.
- Per-cell color quantization with channel corruption: adjacent cells leap between unrelated
  hues (magenta beside lime beside black).
- Horizontal "tear" bands where rows shift — the pixel-sort signature.
- Black voids eat into the body (especially lower chest) — negative space as texture.

**Graphic elements**
- No lines/annotations — the *figure itself* is the only element.
- Reads as a frontal bust: rounded head, tapered neck, sloped shoulders, broad chest fading
  at the bottom edge.

**Layout & grid**
- Centered, ~symmetrical; figure occupies ~70% of frame height. Square (1:1) format.
  Generous black margins L/R. Underlying square pixel grid governs everything.

**Unique stylistic choices**
- Brightest, most chaotic corruption concentrates on the **face** (focal storm); body mass
  is calmer (mostly lime).
- Edges are jagged/aliased on purpose — no anti-aliasing.

## 5. Visual Concept

- **Conceptual bridge:** a human experienced *through* a degraded digital channel — identity
  surviving compression artifacts; presence + corruption at once.
- **Relationship:** limited neon palette + hard pixel grid + black voids keep the body
  readable while denying photographic detail. Remove any one (gradients, small pixels, muted
  colors) and it stops reading as "glitch."
- **For this project:** the figure is a synthetic character **posed/animated by the user's
  gestures** (segmentation silhouette + pose + hands), filled with procedural neon — the
  user never sees their own face. The aesthetic above is the per-frame target.

---

### QA acceptance cues (v2 checklist)

- [ ] Recognizable frontal human **bust** (head + neck + shoulders + chest), centered.
- [ ] Coarse, readable **square** pixel grid (mosaic, not smooth).
- [ ] Limited **neon palette dominated by acid lime/green**, with magenta/cyan/blue/red accents.
- [ ] Near-black background and **black voids** punched into the body.
- [ ] **Densest color corruption on the face**; calmer lime body.
- [ ] Hard, aliased edges; visible horizontal pixel-sort tearing.
- [ ] **NO recognizable webcam image / user's face is NOT visible** — the fill is synthetic, not the live RGB.
- [ ] The character **moves with the user's gestures** in real time (silhouette/pose/hands drive it).
