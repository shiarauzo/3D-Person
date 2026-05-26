"use client";

/**
 * HUD — iter 28
 *
 * Terminal-style corner readout. Fixed position, pointer-events: none.
 * Shows live FPS (rAF-based, throttled to ~3 Hz), TRACKING ON/OFF, HANDS N,
 * and a MODE hint. Lime (#c8f000) accents on active values; low opacity base.
 *
 * FPS approach:
 *   - A rAF loop counts frames and writes to a ref (no setState per frame).
 *   - A setInterval running at ~333 ms (3 Hz) reads the ref, computes fps,
 *     and calls setState once — the only React re-render path.
 *   - Both the rAF and the interval are cleaned up on unmount.
 */

import { useEffect, useRef, useState } from "react";
import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";

// How often to flush the FPS counter to React state (ms).
const FPS_FLUSH_INTERVAL_MS = 333; // ~3 Hz

export default function Hud() {
  const { status } = useWebcamContext();
  const { handCount } = useTrackingContext();

  const [fps, setFps] = useState<number>(0);

  // Frame count accumulated between flush ticks — written in rAF, read in interval.
  const frameCountRef = useRef(0);
  const lastFlushTimeRef = useRef(performance.now());

  useEffect(() => {
    let rafId: number;
    let cancelled = false;

    function tick() {
      if (cancelled) return;
      frameCountRef.current += 1;
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);

    const intervalId = setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastFlushTimeRef.current;
      const frames = frameCountRef.current;

      if (elapsed > 0) {
        setFps(Math.round((frames / elapsed) * 1000));
      }

      frameCountRef.current = 0;
      lastFlushTimeRef.current = now;
    }, FPS_FLUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearInterval(intervalId);
    };
  }, []);

  const trackingOn = status === "ready";

  return (
    <div className="hud" aria-hidden="true">
      <div className="hud__label">GLITCH PORTRAIT</div>
      <div className="hud__divider" />
      <div className="hud__row">
        <span className="hud__key">FPS</span>
        <span className="hud__value hud__value--accent">{fps}</span>
      </div>
      <div className="hud__row">
        <span className="hud__key">TRACKING</span>
        <span
          className={
            trackingOn
              ? "hud__value hud__value--accent"
              : "hud__value hud__value--dim"
          }
        >
          {trackingOn ? "ON" : "OFF"}
        </span>
      </div>
      <div className="hud__row">
        <span className="hud__key">HANDS</span>
        <span
          className={
            handCount > 0
              ? "hud__value hud__value--accent"
              : "hud__value hud__value--dim"
          }
        >
          {handCount}
        </span>
      </div>
      <div className="hud__divider" />
      <div className="hud__hint">MOVE TO GLITCH</div>
    </div>
  );
}
