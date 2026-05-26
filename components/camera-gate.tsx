"use client";

import { useEffect, useRef } from "react";
import { useWebcamContext } from "@/context/webcam-context";
import { useTrackingContext } from "@/context/tracking-context";
import { useDemoContext } from "@/context/demo-context";
import HandDebugOverlay from "@/components/hand-debug-overlay";

/**
 * Toggle to show the hand-landmark debug dots over the video.
 * Kept as a capability but off by default so the final render shows only
 * the glitch mosaic — no debug dots or bbox overlays.
 */
const DEBUG_HANDS = false;

/**
 * How long (ms) the mask must be empty before showing the "STEP INTO FRAME" hint.
 * Task 4 — no-person hint. Prevents flicker on transient detection gaps.
 */
const EMPTY_FRAME_HINT_DELAY_MS = 2000;

export default function CameraGate() {
  const { videoRef, status, error, start } = useWebcamContext();
  const { isDemo } = useDemoContext();

  // Iter 16+: consume the shared tracking context (single detect loop owned by
  // TrackingProvider). Do NOT call useTracking here — that would start a second
  // detect loop and double the MediaPipe CPU cost.
  // Iter 17: also read poseRef + faceBboxRef for debug overlay.
  const { landmarksRef, handCount, poseRef, faceBboxRef, initStatus, retryInit } =
    useTrackingContext();

  // ── Task 4: No-person hint ─────────────────────────────────────────────────
  // Track whether we've been "empty" for EMPTY_FRAME_HINT_DELAY_MS.
  // Use a ref + interval (not rAF setState) to avoid per-frame re-renders.
  // The ref stores a "first-empty-at" timestamp; when it exceeds the delay,
  // a simple class toggle on a pre-rendered element shows the hint.
  const hintElRef   = useRef<HTMLDivElement | null>(null);
  const emptyAtRef  = useRef<number | null>(null);
  const hintVisible = useRef(false);

  useEffect(() => {
    // Only active when tracking is ready and not in demo mode.
    if (initStatus !== "ready" || isDemo) return;

    const intervalId = setInterval(() => {
      const hasPose  = faceBboxRef.current?.active === true;
      const hasHands = (landmarksRef.current?.landmarks?.length ?? 0) > 0;

      // "Person present" = active face bbox OR visible hands.
      // maskTextureRef is allocated once and never reset to null during tracking,
      // so it cannot be used as a presence signal — it stays non-null permanently
      // after the first segmentation frame regardless of whether anyone is in frame.
      const personPresent = hasPose || hasHands;

      const now = performance.now();

      if (!personPresent) {
        if (emptyAtRef.current === null) emptyAtRef.current = now;

        const elapsed = now - emptyAtRef.current;
        if (elapsed >= EMPTY_FRAME_HINT_DELAY_MS && !hintVisible.current) {
          hintVisible.current = true;
          if (hintElRef.current) hintElRef.current.style.opacity = "1";
        }
      } else {
        emptyAtRef.current = null;
        if (hintVisible.current) {
          hintVisible.current = false;
          if (hintElRef.current) hintElRef.current.style.opacity = "0";
        }
      }
    }, 500); // 2 Hz poll — cheap, no per-frame setState

    // Capture ref value at effect setup time so the cleanup closure uses the
    // same DOM node (satisfies react-hooks/exhaustive-deps).
    const hintEl = hintElRef.current;
    return () => {
      clearInterval(intervalId);
      // Reset on effect cleanup so stale hint doesn't linger after demo toggle.
      emptyAtRef.current  = null;
      hintVisible.current = false;
      if (hintEl) hintEl.style.opacity = "0";
    };
  }, [initStatus, isDemo, faceBboxRef, landmarksRef]);

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

      {/* ── Camera permission / state gate ──────────────────────────────────── */}
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

            {/* Task 3: camera API unavailable (insecure context / unsupported browser) */}
            {status === "unsupported" && (
              <>
                <p className="gate-message gate-message--error">
                  CAMERA UNAVAILABLE
                </p>
                <p className="gate-note" style={{ textAlign: "center", lineHeight: 1.7 }}>
                  Camera access needs HTTPS or a supported browser.
                  <br />
                  Try{" "}
                  <a
                    href="?demo=1"
                    style={{ color: "#c8f000", textDecoration: "none" }}
                  >
                    ?demo=1
                  </a>{" "}
                  for a live demo without a camera.
                </p>
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

      {/* ── Task 1: Model-loading overlay ─────────────────────────────────────
          Shown after camera is granted while WASM + model files download.
          Pointer-events: none so the canvas is still interactive underneath.
          Hidden in demo mode (no models to load).                           */}
      {!isDemo && status === "ready" && initStatus === "loading" && (
        <div className="gate-overlay gate-overlay--transparent" aria-live="polite" aria-label="Loading models">
          <div className="gate-panel">
            <span className="gate-status">LOADING MODELS…</span>
          </div>
        </div>
      )}

      {/* Task 1: Model init error — surface with retry. */}
      {!isDemo && status === "ready" && initStatus === "error" && (
        <div className="gate-overlay" role="alertdialog" aria-modal="true" aria-label="Model load error">
          <div className="gate-panel">
            <p className="gate-message gate-message--error">
              MODEL LOAD FAILED — check your connection and retry.
            </p>
            <button
              type="button"
              className="gate-btn"
              onClick={retryInit}
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* ── Task 4: No-person hint ─────────────────────────────────────────────
          Rendered always; opacity toggled imperatively via ref to avoid
          per-frame re-renders. Only relevant when tracking is ready.         */}
      <div
        ref={hintElRef}
        className="no-person-hint"
        aria-hidden="true"
        style={{ opacity: 0 }}
      >
        STEP INTO FRAME
      </div>
    </>
  );
}
