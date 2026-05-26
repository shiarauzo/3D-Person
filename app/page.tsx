import SceneLoader from "@/components/scene-loader";

export default function Home() {
  return (
    <main>
      <div className="overlay">
        <h1>3D Person</h1>
        <p>Drag to orbit · scroll to zoom</p>
      </div>
      <div className="canvas-wrap">
        <SceneLoader />
      </div>
    </main>
  );
}
