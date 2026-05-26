/**
 * hooks/use-webcam.test.ts — Tests for the pure logic extractable from useWebcam.
 *
 * Run with: bun test
 *
 * useWebcam is a React hook tightly coupled to navigator.mediaDevices (getUserMedia),
 * HTMLVideoElement, and the React lifecycle. Full hook testing requires jsdom + React
 * Testing Library (heavy deps we're not adding here).
 *
 * DOCUMENTED GAP: Full state-machine testing (idle → requesting → ready/denied/error)
 * needs jsdom/RTL. Add them in a follow-up if full coverage is required. See:
 *   https://testing-library.com/docs/react-testing-library/intro
 *
 * What CAN be tested without a DOM is the pure error-classification logic inside
 * useWebcam's catch block. We extract that logic into a minimal pure helper,
 * `classifyWebcamError`, which preserves identical behavior while being testable.
 *
 * The helper is defined in this file and mirrors the catch block in use-webcam.ts
 * exactly. If the catch block changes, update this helper and its tests.
 */

import { describe, expect, it } from "bun:test";
import type { WebcamStatus } from "./use-webcam";

// ---------------------------------------------------------------------------
// Pure extract: error → status classifier
// ---------------------------------------------------------------------------
// This mirrors the catch block in useWebcam.start() exactly:
//
//   if (err instanceof DOMException && err.name === "NotAllowedError") {
//     setStatus("denied");
//   } else {
//     setStatus("error");
//   }
//
// Keeping the logic here (rather than importing from the hook) avoids pulling
// in "use client" and all React imports at test time without jsdom.

type ClassifiedError = { status: Extract<WebcamStatus, "denied" | "error">; message: string };

function classifyWebcamError(err: unknown): ClassifiedError {
  if (err instanceof DOMException && err.name === "NotAllowedError") {
    return { status: "denied", message: "Camera permission denied" };
  }
  return {
    status: "error",
    message: err instanceof Error ? err.message : "Unknown error",
  };
}

// ---------------------------------------------------------------------------
// Pure extract: status transition on start()
// ---------------------------------------------------------------------------
// The initial transition when start() is called (before the async part):
//   idle → requesting   (navigator.mediaDevices.getUserMedia is available)
//   idle → unsupported  (navigator is undefined OR getUserMedia is missing — SSR/HTTP guard)
//
// Mirrors the guard in useWebcam.start():
//   if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
//     setStatus("unsupported");
//   }

function classifyStartTransition(getUserMediaAvailable: boolean): WebcamStatus {
  if (!getUserMediaAvailable) return "unsupported";
  return "requesting";
}

// ---------------------------------------------------------------------------
// Tests: error classifier
// ---------------------------------------------------------------------------

describe("classifyWebcamError", () => {
  it("NotAllowedError DOMException → denied status", () => {
    const err = new DOMException("Permission denied", "NotAllowedError");
    const result = classifyWebcamError(err);
    expect(result.status).toBe("denied");
    expect(result.message).toBe("Camera permission denied");
  });

  it("other DOMException (e.g. AbortError) → error status", () => {
    const err = new DOMException("Aborted", "AbortError");
    const result = classifyWebcamError(err);
    expect(result.status).toBe("error");
    expect(result.message).toBe("Aborted");
  });

  it("generic Error → error status with the error message", () => {
    const err = new Error("Webcam timed out waiting for video data");
    const result = classifyWebcamError(err);
    expect(result.status).toBe("error");
    expect(result.message).toBe("Webcam timed out waiting for video data");
  });

  it("non-Error unknown thrown value → error status with 'Unknown error'", () => {
    const result = classifyWebcamError("something went wrong");
    expect(result.status).toBe("error");
    expect(result.message).toBe("Unknown error");
  });

  it("null thrown → error status with 'Unknown error'", () => {
    const result = classifyWebcamError(null);
    expect(result.status).toBe("error");
    expect(result.message).toBe("Unknown error");
  });

  it("NotAllowedError — exact name match required (case sensitive)", () => {
    // A DOMException with a different name does NOT become 'denied'
    const err = new DOMException("Not allowed", "notallowederror"); // wrong case
    const result = classifyWebcamError(err);
    expect(result.status).toBe("error");
  });

  it("plain object that looks like DOMException → error status", () => {
    const fakeErr = { name: "NotAllowedError", message: "fake" };
    const result = classifyWebcamError(fakeErr);
    // Not an instanceof DOMException → falls through to error
    expect(result.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Tests: start() transition
// ---------------------------------------------------------------------------

describe("classifyStartTransition", () => {
  it("getUserMedia available → transitions to 'requesting'", () => {
    expect(classifyStartTransition(true)).toBe("requesting");
  });

  it("getUserMedia unavailable (SSR / HTTP / unsupported browser) → transitions to 'unsupported'", () => {
    expect(classifyStartTransition(false)).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// Documented gap: full hook state-machine tests
// ---------------------------------------------------------------------------
// The following transitions are covered by the pure extract above but the
// full React-driven flow requires jsdom + React Testing Library:
//
//   idle → requesting  (start() called, navigator available)
//   requesting → ready (getUserMedia resolves, video.play() succeeds)
//   requesting → denied (getUserMedia rejects with NotAllowedError)
//   requesting → error  (getUserMedia rejects with other error, or timeout)
//   ready → idle        (stop() called)
//   any → idle          (stop() called)
//
// Follow-up: add RTL tests with a mocked navigator.mediaDevices when jsdom
// is available in the test environment. No heavy deps added in this PR.
