"use client";

import { useState, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import Mosaic from "@/components/mosaic";

// ---------------------------------------------------------------------------
// Iter 26 — Adaptive DPR constants
// ---------------------------------------------------------------------------

/**
 * Floor for the adaptive DPR. 0.75 keeps the piece recognisable on low-end
 * hardware while halving fill-rate relative to dpr=1.5.
 * Ceiling is always 2 (matching the upper bound of the original dpr={[1,2]}).
 */
const DPR_FLOOR = 0.75;
const DPR_CEIL = 2;

/**
 * DPR step per incline/decline event.
 * 0.25 means the range [0.75, 2.0] has five steps:
 *   0.75 → 1.0 → 1.25 → 1.5 → 1.75 → 2.0
 * Small enough to avoid a visible quality jump, large enough to actually
 * reduce fill-rate per step.
 */
const DPR_STEP = 0.25;

export default function Scene() {
  // Adaptive DPR state — lives outside Canvas so it can be passed as a prop.
  // Initialised at 1 (safe mid-range; the Canvas will clamp to [DPR_FLOOR, DPR_CEIL]).
  const [dpr, setDpr] = useState(1);

  // onDecline: fps consistently below the lower bound → step down.
  // Clamped to DPR_FLOOR so we never go below 0.75.
  const handleDecline = useCallback(() => {
    setDpr((prev) => Math.max(DPR_FLOOR, +(prev - DPR_STEP).toFixed(2)));
  }, []);

  // onIncline: fps consistently above the upper bound → step up.
  // Clamped to DPR_CEIL so we never exceed 2.
  const handleIncline = useCallback(() => {
    setDpr((prev) => Math.min(DPR_CEIL, +(prev + DPR_STEP).toFixed(2)));
  }, []);

  return (
    <Canvas
      orthographic
      dpr={dpr}
      camera={{ zoom: 1, position: [0, 0, 5], near: 0.1, far: 100 }}
    >
      {/*
       * Iter 26 — PerformanceMonitor (drei) provides automatic fps hysteresis.
       *
       * Props:
       *   ms=2000        — sampling window per iteration (ms). 2 s gives a
       *                    stable fps average before triggering a change.
       *   iterations=3   — consecutive iterations that must all be out-of-bounds
       *                    before firing onDecline/onIncline. With ms=2000 that's
       *                    a 6 s sustained period before adapting — no thrash.
       *   threshold=0.9  — fraction of [lower, upper] fps bounds that must be
       *                    sustained.  0.9 = 90 % of the target fps range.
       *   bounds          — [lower, upper] fps thresholds derived from the display
       *                    refresh rate. (0.65×rate, 0.85×rate) means:
       *                      decline fires when fps < 0.65 × refreshRate (~39 fps on 60 Hz)
       *                      incline fires when fps > 0.85 × refreshRate (~51 fps on 60 Hz)
       *                    This gives a comfortable band around 45 fps on 60 Hz displays.
       *   flipflops=3    — maximum alternations between decline/incline before the
       *                    monitor locks at a stable "fallback" level. Prevents
       *                    endless oscillation on a device that can't hold a target.
       *
       * onDecline / onIncline update React state → Canvas re-renders with new dpr
       * prop → R3F calls renderer.setPixelRatio(dpr) → Mosaic reads the new value
       * via gl.getPixelRatio() → cellPx recomputes → uPointSize updates via
       * useEffect, keeping the point-sprite tiling correct at the new resolution.
       *
       * GRID_W stays fixed at 64 — adaptive resolution only changes the framebuffer
       * dpr, never the cell count.
       */}
      <PerformanceMonitor
        ms={2000}
        iterations={3}
        threshold={0.9}
        bounds={(refreshrate) => [refreshrate * 0.65, refreshrate * 0.85]}
        flipflops={3}
        onDecline={handleDecline}
        onIncline={handleIncline}
      />

      <color attach="background" args={["#0a0f0a"]} />

      <Mosaic />
    </Canvas>
  );
}
