"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type WebcamStatus = "idle" | "requesting" | "ready" | "denied" | "error" | "unsupported";

export interface UseWebcamReturn {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: WebcamStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

export function useWebcam(): UseWebcamReturn {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Tracks whether the hook is still mounted so async callbacks in start()
  // never call setState after unmount (avoids the React warning and the
  // possibility of a queued setState racing with the unmount cleanup).
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<WebcamStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    // SSR guard — navigator is not available on the server
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      if (mountedRef.current) {
        // Task 3: distinguish "API missing" from a generic error so the gate
        // can surface a specific HTTPS/browser message.
        setStatus("unsupported");
        setError("Camera API unavailable — needs HTTPS or a supported browser");
      }
      return;
    }

    if (mountedRef.current) {
      setStatus("requesting");
      setError(null);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      // Guard: component may have unmounted while getUserMedia was pending.
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        // Component unmounted between the async call and now
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return;
      }

      video.srcObject = stream;

      await new Promise<void>((resolve, reject) => {
        // Fast-path: already have enough data
        if (video.readyState >= 2) {
          resolve();
          return;
        }

        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout>;

        const cleanup = () => {
          video.removeEventListener("loadeddata", onLoadedData);
          clearTimeout(timeoutId);
        };

        const onLoadedData = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };

        const onTimeout = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Webcam timed out waiting for video data"));
        };

        video.addEventListener("loadeddata", onLoadedData);
        // 8-second hard deadline so start() never hangs in 'requesting'
        timeoutId = setTimeout(onTimeout, 8000);
      });

      // Guard: check again after the async wait (unmount may have raced).
      if (!mountedRef.current) return;

      await video.play();

      if (mountedRef.current) setStatus("ready");
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setStatus("denied");
        setError("Camera permission denied");
      } else {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    }
  }, []);

  const stop = useCallback(() => {
    // Always tear down the stream so the camera indicator turns off,
    // regardless of whether the component is still mounted.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    // Only update React state when still mounted. The unmount cleanup calls
    // stop() after setting mountedRef.current = false, so we skip setState
    // there to avoid the "Can't perform a React state update on an unmounted
    // component" warning while still releasing the camera above.
    if (mountedRef.current) {
      setStatus("idle");
      setError(null);
    }
  }, []);

  // Cleanup on unmount (and on Strict-Mode double-invoke): stop the camera
  // so the MediaStream is released and the browser indicator turns off.
  // Also mark the hook as unmounted so any in-flight start() async continuations
  // skip their setState calls.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  return { videoRef, status, error, start, stop };
}
