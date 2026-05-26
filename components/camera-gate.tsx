"use client";

import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";
import HandDebugOverlay from "@/components/hand-debug-overlay";

/**
 * Toggle to show the hand-landmark debug dots over the video.
 * Flip to false (or remove the overlay entirely) once iter 16 is validated.
 */
const DEBUG_HANDS = true;

export default function CameraGate() {
  const { videoRef, status, error, start } = useWebcamContext();

  // Iter 16+: consume the shared tracking context (single detect loop owned by
  // TrackingProvider). Do NOT call useTracking here — that would start a second
  // detect loop and double the MediaPipe CPU cost.
  // Iter 17: also read poseRef + faceBboxRef for debug overlay.
  const { landmarksRef, handCount, poseRef, faceBboxRef } = useTrackingContext();

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

      {/* Debug overlay: mirrored hand dots + pose face bbox (iter 17). */}
      {DEBUG_HANDS && status === "ready" && (
        <HandDebugOverlay
          landmarksRef={landmarksRef}
          poseRef={poseRef}
          faceBboxRef={faceBboxRef}
        />
      )}

      {/* Optional HUD: hand count (only shown when debug is on and hands are seen). */}
      {DEBUG_HANDS && status === "ready" && handCount > 0 && (
        <div
          style={{
            position: "fixed",
            top: 12,
            right: 12,
            color: "#00ff88",
            fontFamily: "monospace",
            fontSize: 12,
            pointerEvents: "none",
            zIndex: 10000,
            background: "rgba(0,0,0,0.55)",
            padding: "2px 8px",
            borderRadius: 4,
          }}
          aria-live="polite"
        >
          hands: {handCount}
        </div>
      )}

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
