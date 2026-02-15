"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
// FortuneSheet types are intentionally loose here because the library's TS surface varies across builds.
import { Workbook } from "@fortune-sheet/react";

export type SheetPlanEditorHandle = {
  /** Best-effort: force FortuneSheet/LuckySheet to commit any in-progress edit (the user is typing in a cell). */
  commitPendingEdits: () => Promise<void>;
  /** Read the *current* workbook snapshot (avoids "one action behind" issues on some deployments). */
  getSnapshot: () => any[] | null;
  /** Raw workbook ref, if needed. */
  workbook?: any;
};

type Props = {
  value: any[];
  onChange: (next: any[]) => void;
  height?: string | number;
  /** Set true to disable editing UI where supported */
  readOnly?: boolean;
  /** Force remount/re-init when switching plans */
  workbookKey?: string;
  className?: string;
  /** Optional imperative handle so parents can snapshot right before save. */
  apiRef?: React.MutableRefObject<SheetPlanEditorHandle | null>;
};

function deepClone<T>(x: T): T {
  try {
    // @ts-ignore
    if (typeof structuredClone === "function") return structuredClone(x);
  } catch {}
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
  const workbookRef = useRef<any>(null);

  // IMPORTANT: treat the sheet as *uncontrolled* after mount.
  // We seed FortuneSheet once (or when workbookKey changes) to avoid React-state feedback loops.
  const [localDoc, setLocalDoc] = useState<any[]>(() => (Array.isArray(value) ? value : []));
  const latestRef = useRef<any[]>(Array.isArray(value) ? value : []);

  useEffect(() => {
    setLocalDoc(Array.isArray(value) ? value : []);
    latestRef.current = Array.isArray(value) ? value : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbookKey]);

  const commitPendingEdits = async () => {
    // Blur any active input to encourage commit.
    try {
      const ae = document.activeElement as any;
      if (ae && typeof ae.blur === "function") ae.blur();
    } catch {}

    // LuckySheet (used under the hood) sometimes exposes helpers on window.luckysheet.
    try {
      const ls = (window as any)?.luckysheet;
      if (ls?.exitEditMode) ls.exitEditMode();
      if (ls?.save) ls.save();
    } catch {}

    // Let the browser flush microtasks + next frame.
    await new Promise<void>((r) => setTimeout(() => r(), 0));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  };

  const getSnapshot = (): any[] | null => {
    // Prefer LuckySheet global snapshot if available (most accurate).
    try {
      const ls = (window as any)?.luckysheet;
      const sheets = ls?.getAllSheets?.();
      if (Array.isArray(sheets) && sheets.length > 0) return deepClone(sheets);
    } catch {}

    // Some FortuneSheet builds expose getAllSheets via the forwarded ref.
    try {
      const sheets = workbookRef.current?.getAllSheets?.();
      if (Array.isArray(sheets) && sheets.length > 0) return deepClone(sheets);
    } catch {}

    // Fallback to our last emitted doc.
    try {
      if (Array.isArray(latestRef.current) && latestRef.current.length > 0) return deepClone(latestRef.current);
    } catch {}
    return null;
  };

  // Expose imperative helpers for "save now" snapshotting.
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      commitPendingEdits,
      getSnapshot,
      workbook: workbookRef.current,
    };
  });

  const handleOp = () => {
    // Capture a fresher snapshot right when an op happens.
    const snap = getSnapshot();
    if (snap) latestRef.current = snap;
    if (snap) onChange(snap);
  };

  // Stable props for Workbook to avoid it re-initializing unnecessarily.
  const workbookProps = useMemo(
    () => ({
      allowEdit: !readOnly,
      showToolbar: !readOnly,
    }),
    [readOnly]
  );

  return (
    <div className={className} style={{ height }}>
      <Workbook
        ref={workbookRef}
        key={workbookKey}
        data={localDoc}
        onOp={handleOp}
        onChange={(next: any) => {
          if (Array.isArray(next)) latestRef.current = next;
          onChange(Array.isArray(next) ? next : []);
        }}
        allowEdit={workbookProps.allowEdit}
        showToolbar={workbookProps.showToolbar}
      />
    </div>
  );
}
