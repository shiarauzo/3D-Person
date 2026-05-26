import SceneLoader from "@/components/scene-loader";
import CameraGate from "@/components/camera-gate";
import { WebcamProvider } from "@/context/webcam-context";
import { TrackingProvider } from "@/context/tracking-context";

export default function Home() {
  return (
    <WebcamProvider>
      {/* TrackingProvider must be inside WebcamProvider (reads videoRef/status)
          and outside both CameraGate and SceneLoader so the single detect loop
          is shared by the debug overlay AND the mosaic deform uniforms. */}
      <TrackingProvider>
        <main>
          <div className="overlay">
            <h1>Glitch Portrait</h1>
            <p>Webcam mosaic — camera required</p>
          </div>
          <div className="canvas-wrap">
            <SceneLoader />
          </div>
          <CameraGate />
        </main>
      </TrackingProvider>
    </WebcamProvider>
  );
}
