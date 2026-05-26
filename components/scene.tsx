"use client";

import { Canvas } from "@react-three/fiber";
import Mosaic from "@/components/mosaic";

export default function Scene() {
  return (
    <Canvas
      orthographic
      dpr={[1, 2]}
      camera={{ zoom: 1, position: [0, 0, 5], near: 0.1, far: 100 }}
    >
      <color attach="background" args={["#0a0f0a"]} />

      <Mosaic />
    </Canvas>
  );
}
