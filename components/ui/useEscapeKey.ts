"use client";

import { useEffect, useRef } from "react";

// Shared stack so that when popups are nested, only the topmost one closes on Escape.
const escStack: Array<{ fire: () => void }> = [];

/**
 * Dismiss a popup (modal/dialog/menu) with the Escape key. Every popup calls this
 * with its close handler; the shared stack ensures only the topmost open popup
 * closes when several are stacked. Pass `active = false` to temporarily disable
 * (e.g. while a save is in flight).
 *
 * This is the app-wide standard — all popups must be Escape-dismissable.
 */
export function useEscapeKey(onClose: () => void, active = true) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active) return;
    const entry = { fire: () => ref.current() };
    escStack.push(entry);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && escStack[escStack.length - 1] === entry) {
        e.preventDefault();
        ref.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = escStack.lastIndexOf(entry);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [active]);
}
