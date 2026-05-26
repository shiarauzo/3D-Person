import SceneLoader from "@/components/scene-loader";
import WebcamDebug from "@/components/webcam-debug";

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
      {/* iter-02: debug webcam feed — replaced by permission gate in iter-03 */}
      <WebcamDebug />
    </main>
  );
}
