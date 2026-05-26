"use client";

import { useWebcam } from "@/hooks/use-webcam";

export default function WebcamDebug() {
  const { videoRef, status, error, start, stop } = useWebcam();

  return (
    <>
      {/* Hidden video element — the hook attaches the stream here */}
      {/* biome-ignore lint/a11y/useMediaCaption: debug element, no captions needed */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{ display: "none" }}
      />

      {/* Debug preview — visible in corner so we can confirm capture works */}
      {status === "ready" && (
        // biome-ignore lint/a11y/useMediaCaption: debug element, no captions needed
        <video
          ref={(el) => {
            if (el && videoRef.current?.srcObject) {
              el.srcObject = videoRef.current.srcObject;
              el.play().catch(() => {});
            }
          }}
          autoPlay
          muted
          playsInline
          style={{
            position: "fixed",
            bottom: 16,
            right: 16,
            width: 240,
            aspectRatio: "16/9",
            borderRadius: 4,
            outline: "1px solid rgba(255,255,255,0.15)",
            objectFit: "cover",
            zIndex: 20,
            transform: "scaleX(-1)", // selfie mirror
          }}
        />
      )}

      {/* Minimal controls */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: 16,
          display: "flex",
          gap: 8,
          zIndex: 20,
          flexDirection: "column",
          alignItems: "flex-start",
        }}
      >
        {status === "idle" && (
          <button onClick={start} className="debug-btn" type="button">
            Enable Camera
          </button>
        )}
        {status === "requesting" && (
          <span className="debug-label">Requesting camera…</span>
        )}
        {status === "ready" && (
          <button onClick={stop} className="debug-btn" type="button">
            Stop Camera
          </button>
        )}
        {status === "denied" && (
          <span className="debug-label" style={{ color: "#f87171" }}>
            Permission denied — allow camera and retry
          </span>
        )}
        {status === "error" && (
          <span className="debug-label" style={{ color: "#f87171" }}>
            Error: {error}
          </span>
        )}
      </div>
    </>
  );
}
