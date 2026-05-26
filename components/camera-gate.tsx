"use client";

import { useWebcamContext } from "@/context/webcam-context";

export default function CameraGate() {
  const { videoRef, status, error, start } = useWebcamContext();

  return (
    <>
      {/* Hidden video — always mounted so the mosaic can sample it */}
      {/* biome-ignore lint/a11y/useMediaCaption: pixel-source element, no captions */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="webcam-hidden"
        aria-hidden="true"
      />

      {status !== "ready" && (
        <div className="gate-overlay" role="dialog" aria-modal="true" aria-label="Camera permission">
          <div className="gate-panel">
            {status === "idle" && (
              <>
                <button
                  type="button"
                  className="gate-btn"
                  onClick={start}
                >
                  Enable Camera
                </button>
                <p className="gate-note">
                  Processing happens on-device. Nothing is uploaded.
                </p>
              </>
            )}

            {status === "requesting" && (
              <span className="gate-status">Requesting Camera…</span>
            )}

            {status === "denied" && (
              <>
                <p className="gate-message gate-message--error">
                  Camera Denied — enable it in your browser settings and retry.
                </p>
                <button
                  type="button"
                  className="gate-btn"
                  onClick={start}
                >
                  Retry
                </button>
              </>
            )}

            {status === "error" && (
              <>
                <p className="gate-message gate-message--error">
                  {error ?? "An unknown error occurred."}
                </p>
                <button
                  type="button"
                  className="gate-btn"
                  onClick={start}
                >
                  Retry
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
