"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useWebcamContext } from "@/context/webcam-context";

/**
 * Renders the live webcam feed onto a plane that fills the shorter axis
 * of the orthographic canvas (square crop, mirrored for selfie view).
 *
 * UV trick for 1:1 crop of a 16:9 source:
 *   - The video is wider than it is tall.
 *   - We keep the full V range [0, 1] and shrink the U range to
 *     center a square slice: U offset = (1 - aspect_inv) / 2
 *   where aspect_inv = videoHeight / videoWidth.
 *   Mirroring is done by flipping U: uStart = 1 - uEnd, uEnd = 1 - uStart.
 */

export default function Mosaic() {
  const { videoRef, status } = useWebcamContext();
  const { size } = useThree();

  // The plane fills the smaller viewport dimension so the square fits fully.
  const planeSize = Math.min(size.width, size.height);

  const texture = useMemo(() => {
    const video = videoRef.current;
    if (!video || status !== "ready") return null;

    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    return tex;
  }, [videoRef, status]);

  // Update UV transform whenever texture or video dimensions settle.
  const meshRef = useRef<THREE.Mesh>(null);

  useEffect(() => {
    if (!texture) return;
    const video = videoRef.current;
    if (!video) return;

    const applyUVs = () => {
      const geo = meshRef.current?.geometry as THREE.PlaneGeometry | undefined;
      if (!geo) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      // Aspect ratio of the video source
      const aspect = vw / vh; // e.g. 1.777 for 16:9

      // We want a square crop: V covers [0,1], U covers a centered slice.
      // Without mirror: uMin = (1 - 1/aspect) / 2, uMax = 1 - uMin
      const uSlice = 1 / aspect; // fraction of U range needed for a square
      const uPad = (1 - uSlice) / 2;
      const uMin = uPad;
      const uMax = 1 - uPad;

      // Mirror (selfie): flip U so left↔right is natural.
      // Mirrored: mapped uMin → uMax, uMax → uMin
      const uBottomLeft  = uMax; // BL
      const uBottomRight = uMin; // BR
      const uTopLeft     = uMax; // TL
      const uTopRight    = uMin; // TR

      // PlaneGeometry UV layout (index 0-3, two triangles):
      // Vertex order: BL=0, BR=1, TL=2, TR=3
      const uvAttr = geo.attributes.uv as THREE.BufferAttribute;
      // BL (0): u=uBottomLeft, v=0
      uvAttr.setXY(0, uBottomLeft, 0);
      // BR (1): u=uBottomRight, v=0
      uvAttr.setXY(1, uBottomRight, 0);
      // TL (2): u=uTopLeft, v=1
      uvAttr.setXY(2, uTopLeft, 1);
      // TR (3): u=uTopRight, v=1
      uvAttr.setXY(3, uTopRight, 1);
      uvAttr.needsUpdate = true;
    };

    // Apply immediately if dimensions are known, else wait.
    if (video.videoWidth) {
      applyUVs();
    } else {
      video.addEventListener("loadedmetadata", applyUVs, { once: true });
      return () => video.removeEventListener("loadedmetadata", applyUVs);
    }
  }, [texture, videoRef]);

  // Dispose texture on unmount to avoid WebGL leaks.
  useEffect(() => {
    return () => {
      texture?.dispose();
    };
  }, [texture]);

  if (!texture) return null;

  return (
    <mesh ref={meshRef} position={[0, 0, 0]}>
      <planeGeometry args={[planeSize, planeSize]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}
