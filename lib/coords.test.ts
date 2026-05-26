/**
 * lib/coords.test.ts — Unit tests for the pure coordinate math in lib/coords.ts.
 *
 * Run with: bun test
 *
 * These tests lock in the EXACT orientation conventions so a future edit that
 * silently inverts the selfie mirror or V-flip will cause a test failure rather
 * than a subtle visual bug.
 */

import { describe, expect, it } from "bun:test";
import {
  computeCropExtents,
  computeGridAuv,
  landmarkToVUv,
  landmarkToWorld,
  lerpScalar,
} from "./coords";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPS = 1e-10;

function near(a: number, b: number, epsilon = EPS): boolean {
  return Math.abs(a - b) < epsilon;
}

// ---------------------------------------------------------------------------
// 1. computeCropExtents
// ---------------------------------------------------------------------------

describe("computeCropExtents", () => {
  it("16:9 at UV_ZOOM=1.25 — returns finite, ordered extents", () => {
    const crop = computeCropExtents(16 / 9, 1.25);
    expect(Number.isFinite(crop.uMinZ)).toBe(true);
    expect(Number.isFinite(crop.uMaxZ)).toBe(true);
    expect(Number.isFinite(crop.vMinZ)).toBe(true);
    expect(Number.isFinite(crop.vMaxZ)).toBe(true);
    expect(crop.uMinZ).toBeLessThan(crop.uMaxZ);
    expect(crop.vMinZ).toBeLessThan(crop.vMaxZ);
    expect(crop.uSliceZ).toBeGreaterThan(0);
    expect(crop.vSliceZ).toBeGreaterThan(0);
  });

  it("16:9 at UV_ZOOM=1.25 — uSliceZ === uMaxZ - uMinZ (within epsilon)", () => {
    const crop = computeCropExtents(16 / 9, 1.25);
    expect(near(crop.uSliceZ, crop.uMaxZ - crop.uMinZ)).toBe(true);
    expect(near(crop.vSliceZ, crop.vMaxZ - crop.vMinZ)).toBe(true);
  });

  it("16:9 at UV_ZOOM=1.25 — crop is centered around 0.5 horizontally", () => {
    const crop = computeCropExtents(16 / 9, 1.25);
    const uCenter = (crop.uMinZ + crop.uMaxZ) / 2;
    // The U center of the 1:1 crop window within 16:9 is uPad + uSlice/2 = 0.5
    expect(near(uCenter, 0.5, 1e-9)).toBe(true);
  });

  it("16:9 at UV_ZOOM=1.25 — crop is centered around 0.5 vertically", () => {
    const crop = computeCropExtents(16 / 9, 1.25);
    const vCenter = (crop.vMinZ + crop.vMaxZ) / 2;
    expect(near(vCenter, 0.5, 1e-9)).toBe(true);
  });

  it("16:9 at UV_ZOOM=1.25 — vSliceZ matches 1/uvZoom convention", () => {
    // vHalf = 0.5 / uvZoom → vSliceZ = 1 / uvZoom
    const crop = computeCropExtents(16 / 9, 1.25);
    expect(near(crop.vSliceZ, 1 / 1.25, 1e-9)).toBe(true);
  });

  it("16:9 at UV_ZOOM=1.25 — concrete numeric regression", () => {
    // With aspect=16/9 and zoom=1.25:
    //   uSlice = 9/16 = 0.5625,  uPad = (1-0.5625)/2 = 0.21875
    //   uCenter = 0.5,  uHalf = 0.5625/(2*1.25) = 0.225
    //   uMinZ ≈ 0.275,  uMaxZ ≈ 0.725,  uSliceZ = 0.45
    //   vHalf = 0.5/1.25 = 0.4,  vMinZ = 0.1,  vMaxZ = 0.9,  vSliceZ = 0.8
    const crop = computeCropExtents(16 / 9, 1.25);
    expect(near(crop.uMinZ, 0.5 - 0.5625 / (2 * 1.25), 1e-9)).toBe(true);
    expect(near(crop.uMaxZ, 0.5 + 0.5625 / (2 * 1.25), 1e-9)).toBe(true);
    expect(near(crop.vMinZ, 0.1, 1e-9)).toBe(true);
    expect(near(crop.vMaxZ, 0.9, 1e-9)).toBe(true);
    expect(near(crop.uSliceZ, 0.5625 / 1.25, 1e-9)).toBe(true);
    expect(near(crop.vSliceZ, 0.8, 1e-9)).toBe(true);
  });

  it("square (1:1) aspect at zoom=1 — uMinZ=0, uMaxZ=1, vMinZ=0, vMaxZ=1", () => {
    const crop = computeCropExtents(1, 1);
    expect(near(crop.uMinZ, 0)).toBe(true);
    expect(near(crop.uMaxZ, 1)).toBe(true);
    expect(near(crop.vMinZ, 0)).toBe(true);
    expect(near(crop.vMaxZ, 1)).toBe(true);
    expect(near(crop.uSliceZ, 1)).toBe(true);
    expect(near(crop.vSliceZ, 1)).toBe(true);
  });

  it("portrait (9:16) aspect at zoom=1 — uSliceZ > 1, crop extends beyond [0,1]", () => {
    // aspect < 1 → uSlice > 1, the crop window is wider than the video (expected)
    const crop = computeCropExtents(9 / 16, 1);
    expect(crop.uSliceZ).toBeGreaterThan(1);
    expect(crop.uSliceZ).toBeGreaterThan(0); // still valid
    expect(near(crop.uSliceZ, 1 / (9 / 16), 1e-9)).toBe(true);
  });

  it("zoom=1.0 on 16:9 — uSliceZ equals 9/16 (full 1:1 crop, no extra zoom)", () => {
    const crop = computeCropExtents(16 / 9, 1.0);
    expect(near(crop.uSliceZ, 9 / 16, 1e-9)).toBe(true);
    expect(near(crop.vSliceZ, 1.0, 1e-9)).toBe(true);
  });

  it("no NaN in any field", () => {
    for (const [aspect, zoom] of [[16 / 9, 1.25], [1, 1], [4 / 3, 1.5], [9 / 16, 1]]) {
      const crop = computeCropExtents(aspect as number, zoom as number);
      for (const val of [crop.uMinZ, crop.uMaxZ, crop.uSliceZ, crop.vMinZ, crop.vMaxZ, crop.vSliceZ]) {
        expect(Number.isNaN(val)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. computeGridAuv — THE bug-prone function
// ---------------------------------------------------------------------------

describe("computeGridAuv", () => {
  // regression guard for the mirror/V-flip bugs (PRs iter12/iter23)

  const crop = computeCropExtents(16 / 9, 1.25);
  const GRID = 64;

  it("REGRESSION: selfie mirror — col 0 (left screen) maps to uMaxZ (right side of video)", () => {
    // The display is NOT mirror-flipped from the viewer's perspective because
    // the geometry assigns the right-most video U to the left-most screen column.
    const [u] = computeGridAuv(0, 0, GRID, GRID, crop);
    expect(near(u, crop.uMaxZ, 1e-9)).toBe(true);
  });

  it("REGRESSION: selfie mirror — right-most col maps to uMinZ (left side of video)", () => {
    const [u] = computeGridAuv(GRID - 1, 0, GRID, GRID, crop);
    expect(near(u, crop.uMinZ, 1e-9)).toBe(true);
  });

  it("REGRESSION: selfie mirror — left column u > right column u (mirror direction)", () => {
    const [uLeft] = computeGridAuv(0, 0, GRID, GRID, crop);
    const [uRight] = computeGridAuv(GRID - 1, 0, GRID, GRID, crop);
    expect(uLeft).toBeGreaterThan(uRight);
  });

  it("REGRESSION: V-flip — row 0 (screen-bottom) maps to vMaxZ (largest v, bottom of video)", () => {
    // Row 0 is the bottom of the screen. The V coordinate should be the largest
    // because raw video V increases downward and the geometry's row 0 is at the
    // bottom of the display, which corresponds to the lower part of the video.
    const [, v] = computeGridAuv(0, 0, GRID, GRID, crop);
    expect(near(v, crop.vMaxZ, 1e-9)).toBe(true);
  });

  it("REGRESSION: V-flip — top row (GRID-1) maps to vMinZ (smallest v, top of video)", () => {
    const [, v] = computeGridAuv(0, GRID - 1, GRID, GRID, crop);
    expect(near(v, crop.vMinZ, 1e-9)).toBe(true);
  });

  it("REGRESSION: V-flip — bottom row v > top row v (increasing downward in video)", () => {
    const [, vBottom] = computeGridAuv(0, 0, GRID, GRID, crop);
    const [, vTop] = computeGridAuv(0, GRID - 1, GRID, GRID, crop);
    expect(vBottom).toBeGreaterThan(vTop);
  });

  it("middle column maps to uCenter (midpoint of crop)", () => {
    // With an even grid, the midpoint column is between indices, so use a 3-cell grid
    const [u] = computeGridAuv(1, 0, 3, 3, crop);
    const uCenter = (crop.uMinZ + crop.uMaxZ) / 2;
    // normCol = 1/(3-1) = 0.5, u = uMaxZ - 0.5*uSliceZ = uCenter (via selfie mirror)
    expect(near(u, uCenter, 1e-9)).toBe(true);
  });

  it("middle row maps to vCenter (midpoint of crop)", () => {
    const [, v] = computeGridAuv(0, 1, 3, 3, crop);
    const vCenter = (crop.vMinZ + crop.vMaxZ) / 2;
    // normRow = 0.5, v = vMinZ + (1-0.5)*vSliceZ = vCenter
    expect(near(v, vCenter, 1e-9)).toBe(true);
  });

  it("all returned uvs are within the crop extents (no out-of-bounds sampling)", () => {
    for (let col = 0; col < GRID; col++) {
      for (let row = 0; row < GRID; row++) {
        const [u, v] = computeGridAuv(col, row, GRID, GRID, crop);
        expect(u).toBeGreaterThanOrEqual(crop.uMinZ - EPS);
        expect(u).toBeLessThanOrEqual(crop.uMaxZ + EPS);
        expect(v).toBeGreaterThanOrEqual(crop.vMinZ - EPS);
        expect(v).toBeLessThanOrEqual(crop.vMaxZ + EPS);
      }
    }
  });

  it("no NaN in returned uvs", () => {
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        const [u, v] = computeGridAuv(col, row, 4, 4, crop);
        expect(Number.isNaN(u)).toBe(false);
        expect(Number.isNaN(v)).toBe(false);
      }
    }
  });

  it("u is monotonically decreasing as col increases (selfie mirror consistency)", () => {
    const us = Array.from({ length: GRID }, (_, col) => computeGridAuv(col, 0, GRID, GRID, crop)[0]);
    for (let i = 1; i < us.length; i++) {
      expect(us[i]).toBeLessThan(us[i - 1]);
    }
  });

  it("v is monotonically decreasing as row increases (V-flip consistency)", () => {
    const vs = Array.from({ length: GRID }, (_, row) => computeGridAuv(0, row, GRID, GRID, crop)[1]);
    for (let i = 1; i < vs.length; i++) {
      expect(vs[i]).toBeLessThan(vs[i - 1]);
    }
  });

  it("2×2 grid — all four corners land on the four corners of the crop", () => {
    // col=0, row=0 → bottom-left screen → (uMaxZ, vMaxZ)  [mirrored right, video bottom]
    // col=1, row=0 → bottom-right screen → (uMinZ, vMaxZ) [mirrored left, video bottom]
    // col=0, row=1 → top-left screen → (uMaxZ, vMinZ)     [mirrored right, video top]
    // col=1, row=1 → top-right screen → (uMinZ, vMinZ)    [mirrored left, video top]
    const [u00, v00] = computeGridAuv(0, 0, 2, 2, crop);
    const [u10, v10] = computeGridAuv(1, 0, 2, 2, crop);
    const [u01, v01] = computeGridAuv(0, 1, 2, 2, crop);
    const [u11, v11] = computeGridAuv(1, 1, 2, 2, crop);
    expect(near(u00, crop.uMaxZ)).toBe(true);
    expect(near(v00, crop.vMaxZ)).toBe(true);
    expect(near(u10, crop.uMinZ)).toBe(true);
    expect(near(v10, crop.vMaxZ)).toBe(true);
    expect(near(u01, crop.uMaxZ)).toBe(true);
    expect(near(v01, crop.vMinZ)).toBe(true);
    expect(near(u11, crop.uMinZ)).toBe(true);
    expect(near(v11, crop.vMinZ)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. landmarkToWorld
// ---------------------------------------------------------------------------

describe("landmarkToWorld", () => {
  const crop = computeCropExtents(16 / 9, 1.25);
  const squarePx = 600;

  it("centered landmark (0.5, 0.5) maps near world origin", () => {
    // xScreen = 1 - 0.5 = 0.5; uCrop = (0.5 - uMinZ) / uSliceZ
    // With a symmetric crop centered at 0.5, uCrop ≈ 0.5, wx ≈ 0
    // vCrop = (0.5 - vMinZ) / vSliceZ = 0.5 (since vCenter = 0.5), wy ≈ 0
    const [wx, wy] = landmarkToWorld(0.5, 0.5, crop, squarePx);
    expect(near(wx, 0, 1e-6)).toBe(true);
    expect(near(wy, 0, 1e-6)).toBe(true);
  });

  it("REGRESSION: selfie mirror — landmark on video-left (xMp=0.1) maps to positive world X", () => {
    // xMp=0.1 (near left of raw video) → xScreen=0.9 (after mirror) → right side of crop
    // → uCrop > 0.5 → wx > 0
    const [wx] = landmarkToWorld(0.1, 0.5, crop, squarePx);
    expect(wx).toBeGreaterThan(0);
  });

  it("REGRESSION: selfie mirror — landmark on video-right (xMp=0.9) maps to negative world X", () => {
    // xMp=0.9 → xScreen=0.1 → left side of crop → uCrop < 0.5 → wx < 0
    const [wx] = landmarkToWorld(0.9, 0.5, crop, squarePx);
    expect(wx).toBeLessThan(0);
  });

  it("REGRESSION: V sign — landmark near top of video (yMp=0.1) maps to positive world Y (upward)", () => {
    // yMp=0.1 (near top of raw video, small V) → vCrop < 0.5 → wy = (0.5 - vCrop)*squarePx > 0
    const [, wy] = landmarkToWorld(0.5, 0.1, crop, squarePx);
    expect(wy).toBeGreaterThan(0);
  });

  it("REGRESSION: V sign — landmark near bottom of video (yMp=0.9) maps to negative world Y", () => {
    // yMp=0.9 → vCrop > 0.5 → wy < 0
    const [, wy] = landmarkToWorld(0.5, 0.9, crop, squarePx);
    expect(wy).toBeLessThan(0);
  });

  it("scales linearly with squarePx", () => {
    const [wx1, wy1] = landmarkToWorld(0.3, 0.3, crop, 600);
    const [wx2, wy2] = landmarkToWorld(0.3, 0.3, crop, 1200);
    expect(near(wx2, wx1 * 2, 1e-9)).toBe(true);
    expect(near(wy2, wy1 * 2, 1e-9)).toBe(true);
  });

  it("no NaN for typical landmark values", () => {
    for (const [x, y] of [[0, 0], [0.5, 0.5], [1, 1], [0.25, 0.75]]) {
      const [wx, wy] = landmarkToWorld(x as number, y as number, crop, squarePx);
      expect(Number.isNaN(wx)).toBe(false);
      expect(Number.isNaN(wy)).toBe(false);
    }
  });

  it("opposite horizontal landmarks produce opposite world X values (symmetry)", () => {
    // xMp=0.2 and xMp=0.8 are equidistant from the center mirror axis
    const [wx1] = landmarkToWorld(0.2, 0.5, crop, squarePx);
    const [wx2] = landmarkToWorld(0.8, 0.5, crop, squarePx);
    expect(near(wx1, -wx2, 1e-9)).toBe(true);
  });

  it("opposite vertical landmarks produce opposite world Y values (symmetry)", () => {
    const [, wy1] = landmarkToWorld(0.5, 0.2, crop, squarePx);
    const [, wy2] = landmarkToWorld(0.5, 0.8, crop, squarePx);
    expect(near(wy1, -wy2, 1e-9)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. landmarkToVUv
// ---------------------------------------------------------------------------

describe("landmarkToVUv", () => {
  it("passes through centerX and centerY unchanged", () => {
    const [u, v] = landmarkToVUv(0.42, 0.77);
    expect(u).toBe(0.42);
    expect(v).toBe(0.77);
  });

  it("zero values pass through", () => {
    const [u, v] = landmarkToVUv(0, 0);
    expect(u).toBe(0);
    expect(v).toBe(0);
  });

  it("returns raw video UV — consistent with computeGridAuv's aUv space", () => {
    // The cell that samples raw-video pixel (cx, cy) has aUv = (cx, cy).
    // landmarkToVUv returns the same value for use in uFaceCenter uniform,
    // so the face storm uniform and the geometry aUv share the same coordinate space.
    const cx = 0.55;
    const cy = 0.45;
    const crop = computeCropExtents(16 / 9, 1.25);
    // Find which grid column would have this U value:
    //   u = uMaxZ - normCol * uSliceZ → normCol = (uMaxZ - cx) / uSliceZ
    const normCol = (crop.uMaxZ - cx) / crop.uSliceZ;
    const normRow = 1 - (cy - crop.vMinZ) / crop.vSliceZ;
    const col = Math.round(normCol * (64 - 1));
    const row = Math.round(normRow * (64 - 1));
    const [auvU, auvV] = computeGridAuv(col, row, 64, 64, crop);
    const [faceU, faceV] = landmarkToVUv(cx, cy);
    // They should be close (within one grid step)
    const stepU = crop.uSliceZ / (64 - 1);
    const stepV = crop.vSliceZ / (64 - 1);
    expect(Math.abs(auvU - faceU)).toBeLessThan(stepU + 1e-6);
    expect(Math.abs(auvV - faceV)).toBeLessThan(stepV + 1e-6);
  });

  it("no NaN for arbitrary inputs", () => {
    for (const [cx, cy] of [[0, 0], [0.5, 0.5], [1, 1]]) {
      const [u, v] = landmarkToVUv(cx as number, cy as number);
      expect(Number.isNaN(u)).toBe(false);
      expect(Number.isNaN(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. lerpScalar
// ---------------------------------------------------------------------------

describe("lerpScalar", () => {
  it("speed=0 → returns current unchanged", () => {
    expect(lerpScalar(5, 10, 0)).toBe(5);
  });

  it("speed=1 → snaps to target instantly", () => {
    expect(lerpScalar(5, 10, 1)).toBe(10);
  });

  it("speed=0.5 → midpoint", () => {
    expect(near(lerpScalar(0, 10, 0.5), 5)).toBe(true);
  });

  it("already at target → returns target", () => {
    expect(lerpScalar(7, 7, 0.5)).toBe(7);
  });

  it("converges toward target over iterations", () => {
    let val = 0;
    const target = 100;
    for (let i = 0; i < 50; i++) {
      val = lerpScalar(val, target, 0.1);
    }
    expect(val).toBeGreaterThan(95);
  });

  it("negative values work correctly", () => {
    const result = lerpScalar(-10, 10, 0.5);
    expect(near(result, 0)).toBe(true);
  });

  it("result = current + (target - current) * speed formula", () => {
    const current = 3;
    const target = 8;
    const speed = 0.3;
    const expected = current + (target - current) * speed;
    expect(near(lerpScalar(current, target, speed), expected)).toBe(true);
  });
});
