"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";

const SKIN = "#e8b48f";
const SHIRT = "#5b7cff";
const PANTS = "#2b2f3a";
const HAIR = "#3a2a22";

/**
 * A stylized low-poly humanoid assembled from primitives.
 * Plays a subtle idle animation: breathing, sway, and arm bob.
 */
export function Person(props: JSX.IntrinsicElements["group"]) {
  const root = useRef<Group>(null);
  const chest = useRef<Group>(null);
  const leftArm = useRef<Group>(null);
  const rightArm = useRef<Group>(null);
  const head = useRef<Group>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (root.current) {
      // gentle weight shift
      root.current.position.y = Math.sin(t * 1.4) * 0.02;
      root.current.rotation.y = Math.sin(t * 0.4) * 0.08;
    }
    if (chest.current) {
      // breathing
      const breathe = 1 + Math.sin(t * 1.4) * 0.015;
      chest.current.scale.set(breathe, breathe, breathe);
    }
    if (head.current) {
      head.current.rotation.y = Math.sin(t * 0.5) * 0.12;
      head.current.rotation.z = Math.sin(t * 0.9) * 0.03;
    }
    if (leftArm.current) leftArm.current.rotation.x = Math.sin(t * 1.4) * 0.06;
    if (rightArm.current) rightArm.current.rotation.x = -Math.sin(t * 1.4) * 0.06;
  });

  return (
    <group ref={root} {...props}>
      {/* Legs */}
      <Limb position={[-0.18, 0.85, 0]} color={PANTS} length={0.85} radius={0.13} />
      <Limb position={[0.18, 0.85, 0]} color={PANTS} length={0.85} radius={0.13} />

      {/* Hips */}
      <mesh position={[0, 1.28, 0]} castShadow>
        <boxGeometry args={[0.52, 0.3, 0.34]} />
        <Mat color={PANTS} />
      </mesh>

      {/* Torso (breathes) */}
      <group ref={chest} position={[0, 1.62, 0]}>
        <mesh castShadow>
          <capsuleGeometry args={[0.32, 0.5, 6, 16]} />
          <Mat color={SHIRT} />
        </mesh>

        {/* Arms hang from the shoulders */}
        <group ref={leftArm} position={[-0.4, 0.28, 0]}>
          <Limb position={[0, -0.42, 0]} color={SHIRT} length={0.8} radius={0.1} hand />
        </group>
        <group ref={rightArm} position={[0.4, 0.28, 0]}>
          <Limb position={[0, -0.42, 0]} color={SHIRT} length={0.8} radius={0.1} hand />
        </group>
      </group>

      {/* Neck */}
      <mesh position={[0, 2.06, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.12, 0.16, 12]} />
        <Mat color={SKIN} />
      </mesh>

      {/* Head */}
      <group ref={head} position={[0, 2.32, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.27, 24, 24]} />
          <Mat color={SKIN} />
        </mesh>
        {/* Hair cap */}
        <mesh position={[0, 0.08, -0.02]} castShadow>
          <sphereGeometry args={[0.29, 24, 24, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
          <Mat color={HAIR} />
        </mesh>
        {/* Eyes */}
        <mesh position={[-0.1, 0.0, 0.24]}>
          <sphereGeometry args={[0.035, 12, 12]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
        <mesh position={[0.1, 0.0, 0.24]}>
          <sphereGeometry args={[0.035, 12, 12]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
      </group>
    </group>
  );
}

function Limb({
  color,
  length,
  radius,
  hand,
  ...props
}: {
  color: string;
  length: number;
  radius: number;
  hand?: boolean;
} & JSX.IntrinsicElements["group"]) {
  return (
    <group {...props}>
      <mesh castShadow>
        <capsuleGeometry args={[radius, length, 6, 12]} />
        <Mat color={color} />
      </mesh>
      {hand && (
        <mesh position={[0, -length / 2 - 0.08, 0]} castShadow>
          <sphereGeometry args={[radius * 1.05, 12, 12]} />
          <Mat color={SKIN} />
        </mesh>
      )}
    </group>
  );
}

function Mat({ color }: { color: string }) {
  return <meshStandardMaterial color={color} roughness={0.75} metalness={0.05} />;
}
