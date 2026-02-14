"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
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
}: Props) {
  const [localDoc, setLocalDoc] = useState<any[]>(value ?? []);
  const latestRef = useRef<any[]>(value ?? []);
  const warnedNoApiRef = useRef(false);
  const workbookRef = useRef<any>(null);

  // keep local+ref synced when parent loads a plan (or changes plans)
  useEffect(() => {
    const next = value ?? [];
    setLocalDoc(next);
    latestRef.current = next;
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
      const snap = readWorkbookNow();
      latestRef.current = snap;
      // Do NOT setLocalDoc on every op (can cause flashes/remount-like behavior).
      onChange(snap);
    });
  }, [onChange, readWorkbookNow]);

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
