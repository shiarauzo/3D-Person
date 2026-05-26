"use client";

/**
 * DemoContext
 *
 * Provides `isDemo` — true when the app is running in demo mode (no camera).
 *
 * Activation:
 *   1. URL query param ?demo=1 (read once on mount, shareable link).
 *   2. Key toggle: pressing "D" while the page is focused flips the mode.
 *
 * In demo mode:
 *   - The camera gate is bypassed (no getUserMedia prompt).
 *   - A fabricated mask + landmarks are injected into the tracking context
 *     via DemoTrackingProvider (see hooks/use-demo-tracking.ts).
 *   - The HUD shows "TRACKING: DEMO".
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

interface DemoContextValue {
  isDemo: boolean;
  toggleDemo: () => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  // Read ?demo=1 once on mount (client-side only).
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo") === "1") {
      setIsDemo(true);
    }
  }, []);

  // Key toggle: pressing "D" flips demo mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in an input / textarea.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "d" || e.key === "D") {
        setIsDemo((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleDemo = () => setIsDemo((prev) => !prev);

  return (
    <DemoContext.Provider value={{ isDemo, toggleDemo }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemoContext(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) {
    throw new Error("useDemoContext must be used inside <DemoProvider>");
  }
  return ctx;
}
