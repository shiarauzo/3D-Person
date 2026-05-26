import SceneLoader from "@/components/scene-loader";
import CameraGate from "@/components/camera-gate";

export default function Home() {
  return (
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
  );
}
