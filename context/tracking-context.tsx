"use client";

/**
 * TrackingContext — iter 18
 *
 * Lifts the single useTracking instance above both CameraGate (debug overlay)
 * and Mosaic (hand-deform uniforms), guaranteeing exactly ONE detectForVideo
 * loop regardless of how many consumers read the landmarks ref.
 *
 * Iter 17 adds: poseRef + faceBboxRef from the PoseLandmarker (data only,
 * no shader wiring yet — that's iter 23).
 *
 * Iter 18 adds: maskTextureRef — a THREE.DataTexture (RedFormat/FloatType,
 * 256×256) holding the latest selfie segmentation confidence mask. The mosaic
 * samples this texture to gate off-person cells to void, producing a clean
 * bust silhouette on the black field.
 *
 * Hierarchy:
 *   <WebcamProvider>           ← owns videoRef + camera lifecycle
 *     <TrackingProvider>       ← owns ONE tracking loop (reads from WebcamContext)
 *       <CameraGate />         ← reads landmarksRef for debug overlay
 *       <Canvas>
 *         <Mosaic />           ← reads landmarksRef + maskTextureRef
 *       </Canvas>
 *     </TrackingProvider>
 *   </WebcamProvider>
 */

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { useWebcamContext } from "@/context/webcam-context";
import { useTracking, type UseTrackingResult } from "@/hooks/use-tracking";

const TrackingContext = createContext<UseTrackingResult | null>(null);

export function TrackingProvider({ children }: { children: ReactNode }) {
  const { videoRef, status } = useWebcamContext();

  // Single tracking loop for the whole app.
  // Returns hand landmarks, pose landmarks, and derived face bbox.
  const tracking = useTracking({
    videoRef,
    enabled: status === "ready",
  });

  return (
    <TrackingContext.Provider value={tracking}>
      {children}
    </TrackingContext.Provider>
  );
}

export function useTrackingContext(): UseTrackingResult {
  const ctx = useContext(TrackingContext);
  if (!ctx) {
    throw new Error("useTrackingContext must be used inside <TrackingProvider>");
  }
  return ctx;
}
