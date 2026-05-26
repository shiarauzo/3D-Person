/**
 * Iteration 9 — Neon palette data for the datamosh pixel-sort aesthetic.
 *
 * Colors are from docs/visual-reference.md — exact hex values, ordered as
 * defined there. Helpers return RAW sRGB byte ratios (r/255, g/255, b/255),
 * NOT managed THREE.Color values, for the same reason as iter 8's uVoidColor:
 * with NoColorSpace on the texture and sRGB renderer output, the shader works
 * in raw sRGB; using THREE.Color (which applies linear conversion under r169
 * ColorManagement) would shift every palette entry ~13× too dark.
 */

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Palette entries (hex strings — canonical source of truth)
// ---------------------------------------------------------------------------

export const PALETTE_HEXES = [
  "#0a0f0a", // 0  Void Black
  "#c8f000", // 1  Acid Lime
  "#39ff5a", // 2  Toxic Green
  "#ff2bb5", // 3  Hot Magenta
  "#19e0e6", // 4  Electric Cyan
  "#2156ff", // 5  Cobalt Blue
  "#ff2a2a", // 6  Signal Red
  "#ff9c2b", // 7  Amber
  "#eef3e6", // 8  Bone White
] as const;

/** Number of colors in the palette (GLSL array size — must stay in sync). */
export const PALETTE_SIZE = 9 as const;

// ---------------------------------------------------------------------------
// Helper — raw sRGB Vector3 array (for GLSL uniform vec3[])
// ---------------------------------------------------------------------------

/**
 * Returns the palette as an array of THREE.Vector3 with raw sRGB ratios
 * (component = byte / 255). These bypass ColorManagement and map 1-to-1 to
 * what the shader outputs, matching the NoColorSpace texture path.
 */
export function paletteAsVector3(): THREE.Vector3[] {
  return PALETTE_HEXES.map((hex) => {
    // Parse "#rrggbb" manually to avoid THREE.Color's linear conversion.
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return new THREE.Vector3(r, g, b);
  });
}

/**
 * Returns the palette as a flat Float32Array [r0,g0,b0, r1,g1,b1, …].
 * Useful for uploading to a WebGL texture or manual buffer if needed.
 */
export function paletteAsFloat32(): Float32Array {
  const out = new Float32Array(PALETTE_SIZE * 3);
  PALETTE_HEXES.forEach((hex, i) => {
    out[i * 3 + 0] = parseInt(hex.slice(1, 3), 16) / 255;
    out[i * 3 + 1] = parseInt(hex.slice(3, 5), 16) / 255;
    out[i * 3 + 2] = parseInt(hex.slice(5, 7), 16) / 255;
  });
  return out;
}
