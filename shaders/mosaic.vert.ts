// Vertex shader for the mosaic point-cloud.
// Extracted from components/mosaic.tsx — do NOT edit the GLSL here directly;
// run `bun run validate:glsl` after any change to catch regressions.
//
// JS-side injected constants (via string concat at ShaderMaterial creation):
//   none — PALETTE_SIZE is a #define in the fragment shader only.
//   ACCENT_COUNT is also fragment-only.
//
// All uniforms are documented in components/mosaic.tsx.

const vertexShader = /* glsl */ `
  attribute vec2 aUv;

  uniform float uPointSize;   // size in physical pixels (already DPR-scaled)

  // Iter 16 — Hand deform uniforms.
  // uHand0/1: smoothed hand world-space position (same coordinate as position.xy).
  // uHandActive0/1: 0.0 = no hand / faded out, 1.0 = fully active.
  // uDeformRadius: radial falloff distance in world units.
  // uDeformStrength: maximum displacement magnitude in world units.
  uniform vec2  uHand0;
  uniform vec2  uHand1;
  uniform float uHandActive0;
  uniform float uHandActive1;
  uniform float uDeformRadius;
  uniform float uDeformStrength;

  // Iter 20 — Motion-reactive intensity.
  // uMotion: normalized motion signal [0, 1] derived from hand velocity.
  // uMotionDeformBoost: multiplier headroom for deform strength at peak motion.
  //   effectiveStrength = uDeformStrength * (1 + uMotion * uMotionDeformBoost)
  //   At motion=0: effectiveStrength == uDeformStrength (iter-19 baseline).
  //   At motion=1: effectiveStrength == uDeformStrength * (1 + boost).
  uniform float uMotion;
  uniform float uMotionDeformBoost; // default 0.6 → up to 60% extra warp

  varying vec2 vUv;

  void main() {
    vUv = aUv;

    // Iter 20 — Scale effective deform strength by motion signal.
    // At idle (uMotion=0) this is identical to iter-19 behaviour.
    float effectiveStrength = uDeformStrength * (1.0 + uMotion * uMotionDeformBoost);

    // Iter 16 — Compute radial push displacement for each active hand.
    // Uses the XY plane (Z=0 for all vertices), so we work entirely in 2D.
    //
    // For each hand:
    //   delta = vertex.xy - hand.xy
    //   dist  = length(delta)
    //   falloff = smoothstep(uDeformRadius, 0.0, dist)
    //             → 1.0 at the hand centre, 0.0 at uDeformRadius and beyond
    //   disp  = normalize(delta) * effectiveStrength * falloff * active
    //
    // Guard: skip normalize when the vertex is exactly at the hand centre
    //   (delta == vec2(0)) to avoid NaN / division-by-zero.
    //
    // The two contributions are summed. Clamping the total prevents runaway
    // displacement from two overlapping hands blowing cells too far off-grid.

    vec3 pos = position;
    vec2 totalDisp = vec2(0.0);

    // Hand 0
    if (uHandActive0 > 0.001) {
      vec2 delta0 = pos.xy - uHand0;
      float dist0 = length(delta0);
      if (dist0 > 0.001) {
        float falloff0 = smoothstep(uDeformRadius, 0.0, dist0);
        totalDisp += normalize(delta0) * effectiveStrength * falloff0 * uHandActive0;
      }
    }

    // Hand 1
    if (uHandActive1 > 0.001) {
      vec2 delta1 = pos.xy - uHand1;
      float dist1 = length(delta1);
      if (dist1 > 0.001) {
        float falloff1 = smoothstep(uDeformRadius, 0.0, dist1);
        totalDisp += normalize(delta1) * effectiveStrength * falloff1 * uHandActive1;
      }
    }

    // Clamp total displacement to 2× effectiveStrength so two overlapping hands
    // can't push a cell more than twice the intended maximum.
    float dispLen = length(totalDisp);
    if (dispLen > effectiveStrength * 2.0) {
      totalDisp = totalDisp / dispLen * effectiveStrength * 2.0;
    }

    pos.xy += totalDisp;

    // Iter 16 (optional): slightly enlarge point near the hand for emphasis.
    // activeBlend is 0 at rest, peaks near 1 when close to an active hand.
    float activeBlend = 0.0;
    if (uHandActive0 > 0.001) {
      float dist0 = length(pos.xy - uHand0);
      activeBlend = max(activeBlend, smoothstep(uDeformRadius, 0.0, dist0) * uHandActive0);
    }
    if (uHandActive1 > 0.001) {
      float dist1 = length(pos.xy - uHand1);
      activeBlend = max(activeBlend, smoothstep(uDeformRadius, 0.0, dist1) * uHandActive1);
    }

    // position.xy are already in world units matching the ortho camera's
    // visible range [-half, +half]; z=0 keeps points on the near plane.
    gl_Position  = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = uPointSize * (1.0 + 0.35 * activeBlend);
    // NOTE (iter 7 trigger): the WebGL spec allows drivers to clamp
    // gl_PointSize at ALIASED_POINT_SIZE_RANGE[1], typically 64–1024 px.
    // If increasing grid density causes cells to shrink below the driver
    // clamp (visible as all points collapsing to the minimum size), switch
    // to InstancedMesh quads (PLAN.md iter 7 fallback) — InstancedMesh is
    // not subject to the gl_PointSize limit.
  }
`;

export default vertexShader;
