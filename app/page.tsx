import SceneLoader from "@/components/scene-loader";
import CameraGate from "@/components/camera-gate";
import Hud from "@/components/hud";
import Controls from "@/components/controls";
import { AppProviders } from "@/components/app-providers";

export default function Home() {
  return (
    <AppProviders>
      <main>
        {/* iter-28: mono HUD — replaces the plain overlay text */}
        <Hud />
        {/* iter-29: live shader control panel */}
        <Controls />
        <div className="canvas-wrap">
          <SceneLoader />
        </div>
        {/* Camera gate is a no-op in demo mode (DemoWebcamProvider sets status="ready") */}
        <CameraGate />
      </main>
    </AppProviders>
  );
}
