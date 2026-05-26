"use client";

/**
 * DemoWebcamProvider
 *
 * Provides a "ready" WebcamContext value without requesting a camera.
 * Used in demo mode so Mosaic's `status !== "ready"` render guard passes
 * and the camera gate overlay stays hidden.
 *
 * videoRef points to a hidden <video> element that is never given a stream.
 * Mosaic in V2 no longer samples the video as a color source (it's MediaPipe-only),
 * so a silent unplayed video element is harmless.
 */

import { useRef, type ReactNode } from "react";
import { WebcamContext } from "@/context/webcam-context";

export function DemoWebcamProvider({ children }: { children: ReactNode }) {
  // A ref that points to a permanently-idle video element.
  // Mosaic reads videoRef only to correct UV aspect ratio once video is ready
  // (correctUVs inside a `status === "ready"` effect). In demo mode we skip
  // that path via uvsCorrected staying false — the placeholder 16:9 UVs are
  // used, which is fine because the demo mask was painted to match.
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const value = {
    videoRef,
    status: "ready" as const,
    error: null,
    start: async () => { /* no-op: no camera in demo mode */ },
    stop: () => { /* no-op */ },
  };

  return (
    <WebcamContext.Provider value={value}>
      {children}
    </WebcamContext.Provider>
  );
}
