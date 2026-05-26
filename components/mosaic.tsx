"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useWebcamContext } from "@/context/webcam-context";

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
 */

// ---------------------------------------------------------------------------
// Shaders — inline GLSL (no extra webpack loaders needed)
// ---------------------------------------------------------------------------

const vertexShader = /* glsl */ `
  attribute vec2 aUv;

  uniform float uPointSize;   // size in physical pixels (already DPR-scaled)

  varying vec2 vUv;

  void main() {
    vUv = aUv;

    // position.xy are already in world units matching the ortho camera's
    // visible range [-half, +half]; z=0 keeps points on the near plane.
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPointSize;
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
  uniform vec3  uVoidColor;      // near-black void (#0a0f0a)  iter 8
  uniform float uVoidThreshold;  // luma below this → snap to void  iter 8

  varying vec2 vUv;

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

    // Iter 8 — Void floor: collapse very dark cells to the exact void color so
    // background noise merges seamlessly with the scene background (#0a0f0a).
    // Luma via Rec.601 weights (GLSL r169-valid; no nonexistent functions used).
    float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
    vec3 finalRgb = luma < uVoidThreshold ? uVoidColor : texColor.rgb;

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
// Component
// ---------------------------------------------------------------------------

export default function Mosaic() {
  const { videoRef, status } = useWebcamContext();
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
      // uVoidThreshold: luma below this snaps to void. 0.12 catches dark
      // background/edge noise without eating the subject (which is much brighter).
      uVoidThreshold: { value: 0.12 },
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

  // -------------------------------------------------------------------------
  // Update UV attributes once real video dimensions are known.
  // -------------------------------------------------------------------------
  const pointsRef = useRef<THREE.Points>(null);
  const uvsCorrected = useRef(false);

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

  // VideoTexture.needsUpdate is set automatically each animation frame
  // by THREE.VideoTexture when the video is playing, but useFrame also
  // gives us a hook to force it in case autoUpdate is not triggered.
  useFrame(() => {
    if (texture) texture.needsUpdate = true;
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
