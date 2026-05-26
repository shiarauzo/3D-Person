"use client";

/**
 * use-mosaic-geometry.ts — BufferGeometry builder for the mosaic point-cloud.
 *
 * Responsibilities:
 *   - Build the GRID_W × GRID_H BufferGeometry (positions + aUv attribute)
 *     once per squarePx change, using pure helpers from lib/coords.ts.
 *   - Correct the aUv attribute once real video dimensions are known
 *     (the initial build uses a 16:9 placeholder aspect; correctUVs replaces
 *     it with the camera's true aspect).
 *   - Maintain cropRef so the landmark → world-space mapping in useFrame
 *     always uses the same crop extents as the geometry. This is the critical
 *     coupling between geometry and per-frame tracking reads.
 *   - Dispose geometry on unmount / squarePx change.
 *
 * Returns:
 *   { geometry, cropRef, pointsRef }
 *   - geometry:  the current THREE.BufferGeometry instance.
 *   - cropRef:   MutableRefObject<CropExtents> — shared with the frame hook.
 *   - pointsRef: ref to attach to <points> so correctUVs can reach the geo.
 */

import { useMemo, useEffect, useRef } from "react";
import * as THREE from "three";
import { computeCropExtents, computeGridAuv, type CropExtents } from "@/lib/coords";

// ---------------------------------------------------------------------------
// Grid constants — single source of truth (mirrors mosaic.tsx)
// ---------------------------------------------------------------------------

/** Number of cells across (and down — grid is always square). 40–80 range. */
export const GRID_W = 64;
/** Derived: same as GRID_W so cells are square. */
export const GRID_H = GRID_W;

/**
 * UV zoom factor. > 1 samples a smaller region of the source video,
 * making the subject appear larger inside the square canvas.
 * 1.25 ≈ 25 % crop inward — typical seated-webcam framing.
 */
export const UV_ZOOM = 1.25;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseMosaicGeometryResult {
  geometry: THREE.BufferGeometry;
  cropRef: React.MutableRefObject<CropExtents>;
  pointsRef: React.RefObject<THREE.Points | null>;
}

interface UseMosaicGeometryOptions {
  squarePx: number;
  /** videoRef from WebcamContext — read for dimensions during UV correction. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** webcam status — correctUVs runs only when "ready". */
  status: string;
}

export function useMosaicGeometry({
  squarePx,
  videoRef,
  status,
}: UseMosaicGeometryOptions): UseMosaicGeometryResult {
  // -------------------------------------------------------------------------
  // Build geometry — once per squarePx change
  // -------------------------------------------------------------------------
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();

    const count = GRID_W * GRID_H;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);

    // Ortho camera zoom=1 → world units == CSS pixels.
    const half  = squarePx / 2;
    const stepX = squarePx / GRID_W;
    const stepY = squarePx / GRID_H;

    // Placeholder 16:9 aspect — corrected once real video dimensions arrive.
    const crop = computeCropExtents(16 / 9, UV_ZOOM);

    let idx = 0;
    for (let row = 0; row < GRID_H; row++) {
      for (let col = 0; col < GRID_W; col++) {
        // World position: step from bottom-left corner, centre of each cell.
        const x = -half + stepX * (col + 0.5);
        const y = -half + stepY * (row + 0.5);

        positions[idx * 3 + 0] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = 0;

        const [u, v] = computeGridAuv(col, row, GRID_W, GRID_H, crop);
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
  // R3F only auto-disposes objects it created from JSX; useMemo instances need manual cleanup.
  useEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry]);

  // -------------------------------------------------------------------------
  // cropRef — shared with the frame hook for landmark → world mapping
  // -------------------------------------------------------------------------
  // Initialised with the SAME placeholder 16:9 extents the geometry build uses,
  // so it's a valid rectangle from frame 0 (not the inconsistent uMaxZ:0/uSliceZ:1
  // it used to hold). Overwritten with the real aspect once video metadata loads.
  const cropRef = useRef<CropExtents>(computeCropExtents(16 / 9, UV_ZOOM));

  // pointsRef — used by correctUVs to access the live geometry attributes.
  const pointsRef = useRef<THREE.Points | null>(null);

  // -------------------------------------------------------------------------
  // correctUVs — update aUv once real video dimensions are known
  // -------------------------------------------------------------------------
  const uvsCorrected = useRef(false);

  useEffect(() => {
    // V2: correctUVs is pinned to webcam status instead of texture.
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
      const crop = computeCropExtents(vw / vh, UV_ZOOM);

      // Cache crop extents for landmark mapping in useFrame.
      cropRef.current = crop;

      const geo = pointsRef.current?.geometry;
      if (!geo) return;
      const uvAttr = geo.attributes.aUv as THREE.BufferAttribute;

      let idx = 0;
      for (let row = 0; row < GRID_H; row++) {
        for (let col = 0; col < GRID_W; col++) {
          const [u, v] = computeGridAuv(col, row, GRID_W, GRID_H, crop);
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

  return { geometry, cropRef, pointsRef };
}
