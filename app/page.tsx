import SceneLoader from "@/components/scene-loader";
import CameraGate from "@/components/camera-gate";
import Hud from "@/components/hud";
import Controls from "@/components/controls";
import { WebcamProvider } from "@/context/webcam-context";
import { TrackingProvider } from "@/context/tracking-context";
import { ControlsProvider } from "@/context/controls-context";

export default function Home() {
  return (
    <WebcamProvider>
      {/* TrackingProvider must be inside WebcamProvider (reads videoRef/status)
          and outside both CameraGate and SceneLoader so the single detect loop
          is shared by the debug overlay AND the mosaic deform uniforms. */}
      <TrackingProvider>
        {/* Iter 29 — ControlsProvider wraps everything that needs live knobs:
            Controls panel (UI) and SceneLoader → Mosaic (uniform consumer). */}
        <ControlsProvider>
          <main>
            {/* iter-28: mono HUD — replaces the plain overlay text */}
            <Hud />
            {/* iter-29: live shader control panel */}
            <Controls />
            <div className="canvas-wrap">
              <SceneLoader />
            </div>
            <CameraGate />
          </main>
        </ControlsProvider>
      </TrackingProvider>
    </WebcamProvider>
  );
}
