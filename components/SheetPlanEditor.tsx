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
};

function deepCloneJson<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

export default function SheetPlanEditor({ value, onChange, height = 520 }: Props) {
  const [localDoc, setLocalDoc] = useState<any[]>(value ?? []);
  const latestRef = useRef<any[]>(value ?? []);
  const warnedNoLuckyRef = useRef(false);

  // keep local+ref synced when parent loads a plan
  useEffect(() => {
    const next = value ?? [];
    setLocalDoc(next);
    latestRef.current = next;
  }, [value]);

  const readWorkbookNow = useCallback(() => {
    if (typeof window === "undefined") return latestRef.current;

    const ls = (window as any).luckysheet;
    if (ls?.getAllSheets) {
      const sheets = ls.getAllSheets();
      return deepCloneJson(sheets);
    }

    if (!warnedNoLuckyRef.current) {
      warnedNoLuckyRef.current = true;
      console.warn("FortuneSheet: window.luckysheet.getAllSheets() not available. Falling back to localDoc.");
    }
    return latestRef.current;
  }, []);

  const handleOp = useCallback(() => {
    // Defer to avoid "setState while rendering ForwardRef"
    queueMicrotask(() => {
      const snap = readWorkbookNow();
      latestRef.current = snap;
      setLocalDoc(snap);
      onChange(snap);
    });
  }, [onChange, readWorkbookNow]);

  return (
    <div style={{ height }}>
      <FortuneWorkbook
        // key helps re-init when switching plans
        data={localDoc}
        onOp={handleOp}
      />
    </div>
  );
}
