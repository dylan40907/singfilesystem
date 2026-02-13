"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export type UseDebouncedAutosaveOptions = {
  enabled: boolean;
  delayMs?: number;
  /** Called when it's time to persist changes. Throw on failure. */
  saveFn: () => Promise<void>;
};

export function useDebouncedAutosave({ enabled, delayMs = 2000, saveFn }: UseDebouncedAutosaveOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const cancel = useCallback(() => {
    pendingRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(async () => {
    if (!enabled) return;

    // If already saving, mark as pending and bail.
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }

    // Prevent a queued timer from also firing
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    inFlightRef.current = true;
    pendingRef.current = false;

    if (mountedRef.current) {
      setStatus("saving");
      setError(null);
    }

    try {
      await saveFn();
      if (mountedRef.current) {
        setStatus("saved");
        setLastSavedAt(new Date());
        setError(null);
      }
    } catch (e: any) {
      if (mountedRef.current) {
        setStatus("error");
        setError(e?.message ?? "Autosave failed");
      }
    } finally {
      inFlightRef.current = false;

      // If something changed while we were saving, schedule another save soon.
      if (pendingRef.current && enabled) {
        pendingRef.current = false;
        timerRef.current = setTimeout(() => {
          flush();
        }, Math.min(750, delayMs));
      } 
    }
  }, [enabled, delayMs, saveFn]);

  const schedule = useCallback(() => {
    if (!enabled) return;

    pendingRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      flush();
    }, delayMs);
  }, [enabled, delayMs, flush]);

  return {
    status,
    lastSavedAt,
    error,
    isSaving: status === "saving",
    schedule,
    flush,
    cancel,
  };
}
