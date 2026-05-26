"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type WebcamStatus = "idle" | "requesting" | "ready" | "denied" | "error";

export interface UseWebcamReturn {
  videoRef: React.RefObject<HTMLVideoElement>;
  status: WebcamStatus;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

export function useWebcam(): UseWebcamReturn {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<WebcamStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    // SSR guard — navigator is not available on the server
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      setStatus("error");
      setError("MediaDevices API not available");
      return;
    }

    setStatus("requesting");
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        // Component unmounted between the async call and now
        stream.getTracks().forEach((t) => t.stop());
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

      await video.play();
      setStatus("ready");
    } catch (err) {
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
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStatus("idle");
    setError(null);
  }, []);

  // Cleanup on unmount (and on Strict-Mode double-invoke): stop the camera
  // so the MediaStream is released and the browser indicator turns off.
  useEffect(() => stop, [stop]);

  return { videoRef, status, error, start, stop };
}
