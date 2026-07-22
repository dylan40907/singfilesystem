"use client";

import { useEffect } from "react";

/**
 * Local draft persistence for modal editors.
 *
 * Editors like the course-object / quiz modal hold their work in local state
 * and only hand it to the parent on Confirm, so an accidental dismiss (Escape
 * or a backdrop click) used to throw the whole thing away. Mirroring the draft
 * into localStorage as it changes means reopening the same editor picks up
 * exactly where the user left off.
 *
 * Drafts are per-browser and are cleared on an explicit Confirm or Cancel.
 */

const PREFIX = "sing:draft:";

export function loadDraft<T>(key: string | null | undefined): T | null {
  if (typeof window === "undefined" || !key) return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveDraft<T>(key: string | null | undefined, value: T): void {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota/private-mode failures are non-fatal — the editor still works.
  }
}

export function clearDraft(key: string | null | undefined): void {
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/** Mirrors `value` into localStorage under `key` whenever it changes. */
export function useDraftAutosave<T>(key: string | null | undefined, value: T): void {
  useEffect(() => {
    if (!key) return;
    saveDraft(key, value);
  }, [key, value]);
}
