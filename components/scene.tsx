"use client";

import { Canvas } from "@react-three/fiber";
import {
  ContactShadows,
  Environment,
  OrbitControls,
} from "@react-three/drei";
import { Person } from "./person";

export default function Scene() {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [3.2, 2.4, 4.8], fov: 38 }}
    >
      <color attach="background" args={["#0b0d12"]} />
      <fog attach="fog" args={["#0b0d12", 8, 18]} />

      {/* Lighting */}
      <ambientLight intensity={0.35} />
      <directionalLight
        position={[5, 8, 5]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0001}
      />
      <directionalLight position={[-6, 3, -4]} intensity={0.6} color="#7aa2ff" />

      {/* Character */}
      <Person position={[0, 0, 0]} />

      {/* Ground + soft shadow */}
      <ContactShadows
        position={[0, -0.01, 0]}
        opacity={0.55}
        scale={12}
        blur={2.4}
        far={6}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
        <circleGeometry args={[8, 64]} />
        <meshStandardMaterial color="#11141b" roughness={1} />
      </mesh>

      <Environment preset="city" />
      <OrbitControls
        enablePan={false}
        minDistance={3}
        maxDistance={9}
        minPolarAngle={0.2}
        maxPolarAngle={Math.PI / 2 - 0.05}
        target={[0, 1, 0]}
      />
    </Canvas>
  );
}
