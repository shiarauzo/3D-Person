import SceneLoader from "@/components/scene-loader";
import CameraGate from "@/components/camera-gate";
import { WebcamProvider } from "@/context/webcam-context";

export default function Home() {
  return (
    <WebcamProvider>
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
    </WebcamProvider>
  );
}
