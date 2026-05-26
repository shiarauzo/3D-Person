"use client";

/**
 * Iter 29 — Live control panel.
 *
 * A collapsible, mono/neon panel in the top-right corner.
 * Default: collapsed (out of the way). Toggle via the TUNE button or key 'H'.
 * Pointer-events: auto — this is interactive.
 *
 * Six labeled range sliders, each bound bidirectionally to ControlsContext.
 * Changing a slider updates context state → useEffect in mosaic writes the
 * new value to the corresponding shader uniform on the next cycle.
 */

import { useEffect, useState, useCallback } from "react";
import { useControlsContext } from "@/context/controls-context";
import { CONTROLS_DEFAULTS } from "@/lib/controls-defaults";

interface SliderSpec {
  key: keyof typeof CONTROLS_DEFAULTS;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SLIDERS: SliderSpec[] = [
  { key: "voidThreshold",   label: "VOID THR",    min: 0.05, max: 0.50,  step: 0.01  },
  { key: "tearProbability", label: "TEAR PROB",   min: 0.00, max: 0.80,  step: 0.01  },
  { key: "tearAmount",      label: "TEAR AMNT",   min: 0.00, max: 0.15,  step: 0.005 },
  { key: "accentAmount",    label: "ACCENT",      min: 0.00, max: 0.60,  step: 0.01  },
  { key: "limeBias",        label: "LIME BIAS",   min: 0.00, max: 1.00,  step: 0.01  },
  { key: "faceAccentBoost", label: "FACE BOOST",  min: 0.00, max: 8.00,  step: 0.1   },
  // V2 — PLAN-V2 issue 11: synthetic-field knobs.
  { key: "noiseScale",      label: "NOISE SCALE", min: 0.02, max: 0.20,  step: 0.002 },
  { key: "noiseDrift",      label: "DRIFT",       min: 0.00, max: 0.30,  step: 0.005 },
  { key: "gradientMix",     label: "GRADIENT",    min: 0.00, max: 1.00,  step: 0.01  },
  { key: "edgeBoost",       label: "EDGE",        min: 0.00, max: 1.00,  step: 0.01  },
  { key: "limeMix",         label: "LIME",        min: 0.00, max: 1.00,  step: 0.01  },
];

export default function Controls() {
  const { controls, setControls } = useControlsContext();
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Keyboard shortcut: 'h' toggles the panel (matching iter convention).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "h" || e.key === "H") toggle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle]);

  const handleChange = (key: keyof typeof CONTROLS_DEFAULTS, raw: string) => {
    const value = parseFloat(raw);
    if (Number.isNaN(value)) return;
    setControls((prev) => ({ ...prev, [key]: value }));
  };

  const handleReset = () => setControls(CONTROLS_DEFAULTS);

  return (
    <div className="ctrl-panel" aria-label="Shader controls">
      {/* Toggle button — always visible */}
      <button
        type="button"
        className="ctrl-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="ctrl-body"
        title="Toggle controls (H)"
      >
        {open ? "HIDE" : "TUNE"}
      </button>

      {/* Collapsible body */}
      {open && (
        <div className="ctrl-body" id="ctrl-body">
          <div className="ctrl-header">
            <span className="ctrl-title">SHADER TUNE</span>
            <button type="button" className="ctrl-reset" onClick={handleReset}>
              RESET
            </button>
          </div>
          <div className="ctrl-divider" />

          {SLIDERS.map(({ key, label, min, max, step }) => {
            const value = controls[key] as number;
            return (
              <div key={key} className="ctrl-row">
                <label className="ctrl-label" htmlFor={`ctrl-${key}`}>
                  {label}
                </label>
                <div className="ctrl-slider-wrap">
                  <input
                    id={`ctrl-${key}`}
                    type="range"
                    className="ctrl-slider"
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={(e) => handleChange(key, e.target.value)}
                  />
                  <span className="ctrl-value">{value.toFixed(step < 0.01 ? 3 : 2)}</span>
                </div>
              </div>
            );
          })}

          <div className="ctrl-divider" />
          <div className="ctrl-hint">H TO HIDE</div>
        </div>
      )}
    </div>
  );
}
