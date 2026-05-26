"use client";

/**
 * DemoTrackingProvider
 *
 * A drop-in replacement for TrackingProvider that is mounted when demo mode
 * is active.  It provides fabricated tracking data (bust mask + orbiting hand
 * + face bbox) via the SAME TrackingContext that TrackingProvider uses, so
 * every downstream consumer (Mosaic, CameraGate, Hud) works identically.
 *
 * No getUserMedia is called, no MediaPipe models are loaded.
 */

import { type ReactNode } from "react";
import { TrackingContext } from "@/context/tracking-context";
import { useDemoTracking } from "@/hooks/use-demo-tracking";

export function DemoTrackingProvider({ children }: { children: ReactNode }) {
  const tracking = useDemoTracking();

  return (
    <TrackingContext.Provider value={tracking}>
      {children}
    </TrackingContext.Provider>
  );
}
