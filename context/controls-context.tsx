"use client";

/**
 * Iter 29 — Controls context.
 *
 * Holds the 7 tunable shader values as React state.
 * The mosaic reads these values and writes them to uniforms.
 * Control changes are user-driven (infrequent); useState + useEffect
 * is the right tool — no need for refs or zustand.
 */

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { CONTROLS_DEFAULTS, type ControlValues } from "@/lib/controls-defaults";

interface ControlsContextValue {
  controls: ControlValues;
  setControls: Dispatch<SetStateAction<ControlValues>>;
}

const ControlsContext = createContext<ControlsContextValue | null>(null);

export function ControlsProvider({ children }: { children: React.ReactNode }) {
  const [controls, setControls] = useState<ControlValues>(CONTROLS_DEFAULTS);

  return (
    <ControlsContext.Provider value={{ controls, setControls }}>
      {children}
    </ControlsContext.Provider>
  );
}

export function useControlsContext(): ControlsContextValue {
  const ctx = useContext(ControlsContext);
  if (!ctx) throw new Error("useControlsContext must be used inside ControlsProvider");
  return ctx;
}
