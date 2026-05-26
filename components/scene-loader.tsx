"use client";

import dynamic from "next/dynamic";

// The scene touches WebGL / window, so load it on the client only.
const Scene = dynamic(() => import("@/components/scene"), { ssr: false });

export default function SceneLoader() {
  return <Scene />;
}
