"use client";

/**
 * useReducedMotion — Task 5 (improvement #6)
 *
 * Returns true when the user's OS/browser reports prefers-reduced-motion: reduce.
 * Subscribes to changes so the value updates dynamically if the user toggles the
 * system preference while the page is open.
 *
 * SSR-safe: returns false on the server (typeof window === "undefined") so the
 * initial render is always "full motion" and there is no hydration mismatch.
 * The first client-side useEffect corrects the value immediately.
 */

import { useEffect, useState } from "react";

const MQ = "(prefers-reduced-motion: reduce)";

function getPreference(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(MQ).matches;
}

export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);

  useEffect(() => {
    // Set the correct value on first client render.
    const mq = window.matchMedia(MQ);
    setReducedMotion(mq.matches);

    // Listen for preference changes (e.g. user toggles OS accessibility setting).
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reducedMotion;
}

export { getPreference };
