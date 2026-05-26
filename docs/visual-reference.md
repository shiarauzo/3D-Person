# Visual Style Reference — "Glitched Body"

> Source: `a2477a52b4c5b03f4a5b116dcfdd6257.webp` — a frontal bust of a human figure
> (head, neck, shoulders, chest) rendered as a corrupted, pixel-sorted bitmap on a
> near-black field. This document is the **source of truth** the QA agent compares
> every iteration against.

---

## 1. Core Aesthetic

- **Style name: Datamosh Pixel-Sort Portrait** (a.k.a. "glitched body / databent bust")
- **Design philosophy:** A recognizable human silhouette dissolved into a grid of
  corrupted pixels — the body is *legible as a body* yet *visibly broken*, the tension
  between organic form and digital decay.
- **Key influences / hybrid styles:**
  - Databending / glitch art (corrupted JPEG/RAW channel shifts)
  - Pixel sorting (Kim Asendorf-style threshold sorts)
  - Low-bit / quantized dithering (limited palette, blocky)
  - CRT / teletext neon-on-black phosphor look
  - Generative "ASCII/mosaic portrait" treatments

## 2. Color Palette

Loud, saturated, near-fluorescent colors punched out of a black ground. ~7–9 dominant
hues; high chroma, almost no mid-tones (the dithering jumps between extremes).

| Color | Hex (approx) | Usage context |
|-------|-------------|---------------|
| Void Black | `#0a0f0a` | Background field + "holes" punched through the body |
| Acid Lime | `#c8f000` | Dominant skin/body fill — the base mass of the figure |
| Toxic Green | `#39ff5a` | Secondary fill, highlights along shoulders/chest |
| Hot Magenta | `#ff2bb5` | Glitch streaks, scattered accent pixels |
| Electric Cyan | `#19e0e6` | Cool accent, neck + shoulder fragments |
| Cobalt Blue | `#2156ff` | Shadow/recess fragments, lower torso bands |
| Signal Red | `#ff2a2a` | Sparse hot accents in the face/chest |
| Amber | `#ff9c2b` | Rare warm flecks |
| Bone White | `#eef3e6` | Brightest specular pixels (very sparse) |

- **Total color count:** small, quantized palette (≈8 core colors) — the look depends on
  *limited* colors slammed against each other, not a smooth gradient.
- **Contrast/tension:** warm neon (lime/magenta/red) vs. cold (cyan/blue), all floating
  on a desaturated black-green ground → maximal vibration at the edges.

## 3. Typography System

The source image is **type-free** (pure image). For the app's overlay/UI, the reference
implies a matching treatment:

- **Headline:** monospace, uppercase, wide letter-spacing (terminal/teletext feel).
  Suggested: Geist Mono / IBM Plex Mono, 600 weight.
- **Body/secondary:** same monospace at low opacity (~0.5), small scale — like system
  readouts ("FPS", "TRACKING: ON").
- **Hierarchy:** label → caption only; the image is the hero. Keep UI minimal and out of
  the figure's space.
- **Special considerations:** monospace reinforces the "data/corruption" theme; avoid
  serif/humanist fonts — they fight the aesthetic.

## 4. Key Design Elements

**Textures & treatments**
- Coarse, *visible* pixel grid — cells are large enough to read individually (mosaic, not
  photoreal). Roughly a 40–80 cell-wide grid across the figure.
- Per-cell color quantization with channel corruption: adjacent cells leap between
  unrelated hues (magenta beside lime beside black).
- Horizontal "tear" bands where rows shift — the pixel-sort signature.
- Black voids eat into the body (especially lower chest) — negative space as texture.

**Graphic elements**
- No lines, annotations, or shapes — the *figure itself* is the only element.
- Silhouette reads as a frontal bust: rounded head, tapered neck, sloped shoulders,
  broad chest fading at the bottom edge.

**Layout & grid**
- Centered, symmetrical-ish composition; figure occupies ~70% of the frame height.
- Square (1:1) format. Generous black margin left/right.
- Underlying square pixel grid governs everything.

**Unique stylistic choices**
- The brightest, most chaotic corruption concentrates on the **face** (where a viewer
  looks first) — densest color noise there.
- Body mass is calmer (mostly lime) so the face reads as the focal storm.
- Edges are jagged/aliased on purpose — no anti-aliasing.

## 5. Visual Concept

- **Conceptual bridge:** a human being experienced *through* a degraded digital channel —
  identity surviving compression artifacts. Presence + corruption at once.
- **Relationship between elements:** the limited neon palette + hard pixel grid + black
  voids work together to keep the body readable while denying any photographic detail;
  remove any one (add gradients, shrink pixels, mute colors) and it stops reading as
  "glitch."
- **For this project (the motion goal):** the figure must **move with the user** — a live
  webcam feed of the person, segmented and re-rendered through this datamosh/pixel-sort
  treatment in real time, so the glitched bust mirrors head/shoulder/hand motion. The
  aesthetic above is the target each rendered frame should resemble.
- **Ideal use cases:** interactive installation, live-performance visuals, an expressive
  "presence" portrait, music/AV reactive piece.

---

### QA acceptance cues (quick checklist)

- [ ] Recognizable frontal human bust (head + neck + shoulders + chest), centered.
- [ ] Coarse, readable square pixel grid (mosaic, not smooth).
- [ ] Limited neon palette dominated by **acid lime/green**, with magenta/cyan/blue/red accents.
- [ ] Near-black background and black voids punched into the body.
- [ ] Densest color corruption on the **face**; calmer lime body.
- [ ] Hard, aliased edges; visible horizontal pixel-sort tearing.
- [ ] **Moves** in real time with the user's webcam motion.
