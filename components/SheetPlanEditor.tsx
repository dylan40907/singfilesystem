"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import "@fortune-sheet/react/dist/index.css";

const FortuneWorkbook = dynamic(
  () => import("@fortune-sheet/react").then((m) => m.Workbook),
  { ssr: false }
);

type Props = {
  value: any[];
  onChange: (next: any[]) => void;
  height?: string | number;
  /** Set true to disable editing UI where supported */
  readOnly?: boolean;
  /** Force remount/re-init when switching plans */
  workbookKey?: string;
  className?: string;
  /** Optional: access FortuneSheet API (e.g., getAllSheets) from parent */
  apiRef?: MutableRefObject<any | null>;
};

function deepCloneJson<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

export default function SheetPlanEditor({
  value,
  onChange,
  height = 520,
  readOnly = false,
  workbookKey,
  className,
  apiRef,
}: Props) {
  const [localDoc, setLocalDoc] = useState<any[]>(value ?? []);
  const latestRef = useRef<any[]>(value ?? []);
  const lastSentJsonRef = useRef<string>("");
  const warnedNoApiRef = useRef(false);
  const workbookRef = useRef<any>(null);
  // Expose workbook API to parents (for save-time snapshots)
  useEffect(() => {
    if (apiRef) {
      apiRef.current = workbookRef.current;
    }
  }, [apiRef, workbookKey]);


  // keep local+ref synced when parent loads a plan (or changes plans)
  useEffect(() => {
    const next = value ?? [];
    setLocalDoc(next);
    latestRef.current = next;
    // baseline for change-detection (prevents endless "different" snapshots)
    try {
      lastSentJsonRef.current = JSON.stringify(next);
    } catch {
      lastSentJsonRef.current = "";
    }
  }, [workbookKey]);

  const readWorkbookNow = useCallback((): any[] => {
    if (typeof window === "undefined") return latestRef.current;

    // ✅ Primary: FortuneSheet ref API (works even when window.luckysheet isn't exposed)
    const api = workbookRef.current;
    if (api?.getAllSheets) {
      try {
        const sheets = api.getAllSheets();
        return deepCloneJson(sheets);
      } catch (err) {
        console.warn("FortuneSheet: workbookRef.getAllSheets() threw. Falling back.", err);
      }
    }

    // Secondary: legacy global (some builds expose this)
    const ls = (window as any).luckysheet;
    if (ls?.getAllSheets) {
      try {
        const sheets = ls.getAllSheets();
        return deepCloneJson(sheets);
      } catch (err) {
        console.warn("FortuneSheet: window.luckysheet.getAllSheets() threw. Falling back.", err);
      }
    }

    if (!warnedNoApiRef.current) {
      warnedNoApiRef.current = true;
      console.warn("FortuneSheet: getAllSheets() not available (ref/global). Falling back to latest local snapshot.");
    }
    return latestRef.current;
  }, []);

  const handleOp = useCallback(() => {
    // Defer to avoid "setState while rendering ForwardRef"
    queueMicrotask(() => {
      if (apiRef) apiRef.current = workbookRef.current;
      const snap = readWorkbookNow();
      let json = "";
      try {
        json = JSON.stringify(snap);
      } catch {
        // ignore
      }
      if (json && json === lastSentJsonRef.current) return;
      if (json) lastSentJsonRef.current = json;
      latestRef.current = snap;
      // IMPORTANT: do not setLocalDoc here; feeding snapshots back into FortuneSheet can cause loops.
      onChange(snap);
    });
  }, [apiRef, onChange, readWorkbookNow]);

  
// Production safeguard: some builds don't reliably fire FortuneSheet op callbacks.
// Poll periodically for workbook changes and emit them to the parent so manual Save exports the latest doc.
useEffect(() => {
  if (readOnly) return;
  const id = window.setInterval(() => {
    try {
      const snap = readWorkbookNow();
      const json = JSON.stringify(snap);
      if (!json || json === lastSentJsonRef.current) return;
      lastSentJsonRef.current = json;
      latestRef.current = snap;
      // Do NOT setLocalDoc(snap) here; it can trigger FortuneSheet to re-emit changes.
      onChange(snap);
    } catch {
      // ignore
    }
  }, 1200);
  return () => window.clearInterval(id);
}, [onChange, readWorkbookNow, readOnly]);

return (
    <div style={{ height }} className={className}>
      <FortuneWorkbook
        ref={workbookRef}
        key={workbookKey}
        data={localDoc}
        onOp={handleOp}
        allowEdit={!readOnly}
        showToolbar={!readOnly}
      />
    </div>
  );
}
