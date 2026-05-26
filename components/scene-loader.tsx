"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// The scene touches WebGL / window, so load it on the client only.
const Scene = dynamic(() => import("@/components/scene"), { ssr: false });

/**
 * Task 2 — WebGL unsupported fallback.
 *
 * Runs a cheap context probe on the client before mounting the R3F Canvas.
 * If neither webgl2 nor webgl is available, renders a mono error message
 * instead of crashing or showing a blank page.
 *
 * The check is client-only (useEffect + state) so SSR never touches
 * document.createElement — safe for Next.js App Router server rendering.
 *
 * Three possible states while the component runs on the client:
 *   "unknown" — initial SSR/hydration state (renders nothing to avoid flicker).
 *   "supported" — WebGL available → mount Scene normally.
 *   "unsupported" — no WebGL → show error message.
 */
type WebGLSupport = "unknown" | "supported" | "unsupported";

function probeWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl")
    );
  } catch {
    return false;
  }
}

export default function SceneLoader() {
  const [webgl, setWebgl] = useState<WebGLSupport>("unknown");

  useEffect(() => {
    setWebgl(probeWebGL() ? "supported" : "unsupported");
  }, []);

  if (webgl === "unknown") return null;

  if (webgl === "unsupported") {
    return (
      <div className="webgl-unavailable" role="alert">
        <p className="webgl-unavailable__title">WEBGL NOT SUPPORTED</p>
        <p className="webgl-unavailable__body">
          This piece needs a WebGL-capable browser.
          <br />
          Try Chrome, Firefox, or Edge with hardware acceleration enabled.
        </p>
      </div>
    );
  }

  return <Scene />;
}
