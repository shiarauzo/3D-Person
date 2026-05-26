"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useWebcamContext } from "@/context/webcam-context";

/**
 * Iteration 5 — Points grid sampling the video.
 *
 * Replaces the iter-4 textured plane with a THREE.Points grid.
 * Each point samples the video texture at its own UV via a ShaderMaterial,
 * producing a coarse, blocky mosaic reconstruction of the live feed.
 *
 * UV crop math (same as iter-4, 16:9 → 1:1 centered, mirrored selfie):
 *   uSlice = 1 / aspect
 *   uPad   = (1 - uSlice) / 2
 *   Mirrored: point U = uMax - normalizedCol * uSlice
 *             point V = normalizedRow (0 bottom → 1 top)
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
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uVideo;

  varying vec2 vUv;

  void main() {
    // Discard fragments outside the circular point sprite boundary so each
    // cell is a filled square rather than a circle — we simply keep the full
    // quad by NOT using gl_PointCoord distance test (square cells desired).
    //
    // Color path: tex.colorSpace = THREE.NoColorSpace means the GPU samples
    // raw bytes with no color-space conversion applied by Three.js. The video
    // stream is natively sRGB-encoded, so the sampled values are already in
    // display-ready sRGB — output them directly. The renderer's output
    // colorspace is also sRGB, so there is no double-encode.
    gl_FragColor = texture2D(uVideo, vUv);
  }
`;

// ---------------------------------------------------------------------------
// Grid constants
// ---------------------------------------------------------------------------

const GRID_W = 60;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Mosaic() {
  const { videoRef, status } = useWebcamContext();
  const { size, gl } = useThree();

  // Square side in CSS pixels (shorter axis so grid fits fully).
  const squarePx = Math.min(size.width, size.height);

  // Cell size in physical pixels (DPR-scaled so points tile without gaps).
  const dpr = gl.getPixelRatio();
  const cellPx = (squarePx / GRID_W) * dpr;

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

    const count = GRID_W * GRID_W;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);

    // The ortho camera has zoom=1, so world units == CSS pixels.
    // The grid spans squarePx × squarePx centred at origin.
    const half = squarePx / 2;
    const stepX = squarePx / GRID_W;
    const stepY = squarePx / GRID_W;

    // UV crop math: 16:9 video → centered 1:1 square, mirrored.
    // We use placeholder aspect=16/9 here; it is corrected each frame via
    // the uVideo uniform itself — the GPU samples the actual texture, so
    // the UV attribute only needs to encode the final correct values.
    // We pre-compute with fallback aspect 16/9 and update once metadata loads.
    const aspect = 16 / 9;
    const uSlice = 1 / aspect;
    const uPad = (1 - uSlice) / 2;
    const uMax = 1 - uPad;    // right edge of the square crop (mirrored start)

    let idx = 0;
    for (let row = 0; row < GRID_W; row++) {
      for (let col = 0; col < GRID_W; col++) {
        // World position: step from bottom-left corner, centre of each cell.
        const x = -half + stepX * (col + 0.5);
        const y = -half + stepY * (row + 0.5);

        positions[idx * 3 + 0] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = 0;

        // Normalized grid coords [0, 1].
        const normCol = col / (GRID_W - 1);
        const normRow = row / (GRID_W - 1);

        // V: 0 = bottom, 1 = top (video origin at top → flip V).
        const v = 1 - normRow;

        // U: mirrored (selfie). Without mirror: uMin + normCol * uSlice.
        // Mirrored: uMax - normCol * uSlice.
        const u = uMax - normCol * uSlice;

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
      uVideo:     { value: texture },
      uPointSize: { value: cellPx },
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

      const aspect = vw / vh;
      const uSlice = 1 / aspect;
      const uPad = (1 - uSlice) / 2;
      const uMax = 1 - uPad;

      const geo = pointsRef.current?.geometry;
      if (!geo) return;
      const uvAttr = geo.attributes.aUv as THREE.BufferAttribute;

      let idx = 0;
      for (let row = 0; row < GRID_W; row++) {
        for (let col = 0; col < GRID_W; col++) {
          const normCol = col / (GRID_W - 1);
          const normRow = row / (GRID_W - 1);
          const v = 1 - normRow;
          const u = uMax - normCol * uSlice;
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
        // sizeAttenuation=false is the default for ShaderMaterial with
        // gl_PointSize; we handle sizing explicitly in the vertex shader.
      />
    </points>
  );
}
