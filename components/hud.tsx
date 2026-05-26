"use client";

/**
 * HUD — iter 28 + demo mode + capture button
 *
 * Terminal-style corner readout. Fixed position, pointer-events: none on the
 * readout; pointer-events: auto on the capture button.
 * Shows live FPS (rAF-based, throttled to ~3 Hz), TRACKING ON/OFF/DEMO,
 * HANDS N, and a MODE hint. Lime (#c8f000) accents on active values.
 *
 * Demo mode additions:
 *   - TRACKING row shows "DEMO" (lime) instead of ON/OFF.
 *
 * Capture button:
 *   - Small [CAP] button below the HUD panel that calls captureFrame() on the
 *     WebGL canvas.  Also responds to the global "P" key (wired in scene.tsx).
 *   - Requires preserveDrawingBuffer=true on the Canvas (set in scene.tsx).
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";
import { useDemoContext } from "@/context/demo-context";
import { captureFrame } from "@/components/scene";

// How often to flush the FPS counter to React state (ms).
const FPS_FLUSH_INTERVAL_MS = 333; // ~3 Hz

export default function Hud() {
  const { status } = useWebcamContext();
  const { handCount } = useTrackingContext();
  const { isDemo } = useDemoContext();

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

  const trackingOn = status === "ready" && !isDemo;

  // Determine the tracking label and CSS class.
  const trackingLabel = isDemo ? "DEMO" : trackingOn ? "ON" : "OFF";
  const trackingClass = isDemo
    ? "hud__value hud__value--accent"
    : trackingOn
      ? "hud__value hud__value--accent"
      : "hud__value hud__value--dim";

  // Capture: find the WebGL canvas and download a PNG.
  const handleCapture = useCallback(() => {
    // The R3F canvas is the only <canvas> in the page; select it directly.
    const canvas = document.querySelector<HTMLCanvasElement>("canvas");
    if (canvas) captureFrame(canvas);
  }, []);

  return (
    <>
      <div className="hud" aria-hidden="true">
        <div className="hud__label">GLITCH PORTRAIT</div>
        <div className="hud__divider" />
        <div className="hud__row">
          <span className="hud__key">FPS</span>
          <span className="hud__value hud__value--accent">{fps}</span>
        </div>
        <div className="hud__row">
          <span className="hud__key">TRACKING</span>
          <span className={trackingClass}>{trackingLabel}</span>
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
        <div className="hud__hint">{isDemo ? "DEMO MODE — D TO EXIT" : "MOVE TO GLITCH"}</div>
        {isDemo && (
          <div className="hud__hint" style={{ marginTop: 2 }}>
            P OR [CAP] TO SAVE PNG
          </div>
        )}
      </div>

      {/* Capture button — pointer-events: auto so it's clickable. */}
      <button
        type="button"
        aria-label="Capture frame as PNG"
        onClick={handleCapture}
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          background: "rgba(0,0,0,0.72)",
          border: "1px solid rgba(200,240,0,0.35)",
          color: "#c8f000",
          fontFamily: "monospace",
          fontSize: 11,
          letterSpacing: "0.08em",
          padding: "4px 10px",
          cursor: "pointer",
          zIndex: 1000,
          borderRadius: 2,
        }}
      >
        CAP
      </button>
    </>
  );
}
