"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useWebcam, type WebcamStatus } from "@/hooks/use-webcam";

interface WebcamContextValue {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: WebcamStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

const WebcamContext = createContext<WebcamContextValue | null>(null);

export function WebcamProvider({ children }: { children: ReactNode }) {
  const webcam = useWebcam();
  return (
    <WebcamContext.Provider value={webcam}>{children}</WebcamContext.Provider>
  );
}

export function useWebcamContext(): WebcamContextValue {
  const ctx = useContext(WebcamContext);
  if (!ctx) {
    throw new Error("useWebcamContext must be used inside <WebcamProvider>");
  }
  return ctx;
}
