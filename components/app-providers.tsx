"use client";

/**
 * AppProviders
 *
 * Client component that wires up context providers, branching on demo mode.
 *
 * Normal mode (no ?demo=1):
 *   WebcamProvider → TrackingProvider → ControlsProvider → children
 *
 * Demo mode (?demo=1 or D key):
 *   DemoWebcamProvider → DemoTrackingProvider → ControlsProvider → children
 *
 * Both paths expose identical context shapes so all consumers are unchanged.
 */

import { type ReactNode } from "react";
import { DemoProvider, useDemoContext } from "@/context/demo-context";
import { WebcamProvider } from "@/context/webcam-context";
import { TrackingProvider } from "@/context/tracking-context";
import { DemoWebcamProvider } from "@/context/demo-webcam-context";
import { DemoTrackingProvider } from "@/context/demo-tracking-context";
import { ControlsProvider } from "@/context/controls-context";

function InnerProviders({ children }: { children: ReactNode }) {
  const { isDemo } = useDemoContext();

  if (isDemo) {
    return (
      <DemoWebcamProvider>
        <DemoTrackingProvider>
          <ControlsProvider>
            {children}
          </ControlsProvider>
        </DemoTrackingProvider>
      </DemoWebcamProvider>
    );
  }

  return (
    <WebcamProvider>
      <TrackingProvider>
        <ControlsProvider>
          {children}
        </ControlsProvider>
      </TrackingProvider>
    </WebcamProvider>
  );
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <DemoProvider>
      <InnerProviders>{children}</InnerProviders>
    </DemoProvider>
  );
}
