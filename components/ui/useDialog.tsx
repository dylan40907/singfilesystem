"use client";

import { useCallback, useState } from "react";

type DialogState = {
  type: "confirm" | "alert";
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (value: boolean) => void;
} | null;

/**
 * Drop-in replacement for window.confirm() and window.alert() using custom modals.
 *
 * Usage:
 *   const { confirm, alert, modal } = useDialog();
 *   // add {modal} to your JSX
 *   const ok = await confirm("Are you sure?");
 *   await alert("Something went wrong.");
 */
export function useDialog() {
  const [state, setState] = useState<DialogState>(null);

  const confirm = useCallback(
    (
      message: string,
      opts: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {}
    ): Promise<boolean> =>
      new Promise((resolve) => {
        setState({ type: "confirm", message, ...opts, resolve });
      }),
    []
  );

  const alert = useCallback(
    (message: string, opts: { title?: string } = {}): Promise<void> =>
      new Promise((resolve) => {
        setState({
          type: "alert",
          message,
          title: opts.title,
          confirmLabel: "OK",
          resolve: () => resolve(),
        });
      }),
    []
  );

  function close(value: boolean) {
    state?.resolve(value);
    setState(null);
  }

  const modal = state ? (
    <>
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 9000 }}
        onMouseDown={() => { if (state.type === "alert") close(false); }}
      />
      <div
        style={{
          position: "fixed", top: "50%", left: "50%",
          transform: "translate(-50%,-50%)", zIndex: 9001,
          background: "white", borderRadius: 14,
          boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
          padding: 24, width: 380, maxWidth: "calc(100vw - 32px)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {state.title && (
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8, color: state.danger ? "#dc2626" : "#111827" }}>
            {state.title}
          </div>
        )}
        <div style={{ fontSize: 14, color: "#374151", lineHeight: 1.6, whiteSpace: "pre-line" }}>
          {state.message}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
          {state.type === "confirm" && (
            <button
              className="btn"
              onClick={() => close(false)}
              style={{ padding: "8px 18px", fontSize: 13 }}
            >
              {state.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            onClick={() => close(true)}
            style={{
              padding: "8px 18px", fontSize: 13, fontWeight: 700,
              borderRadius: 10, border: "none", cursor: "pointer",
              background: state.danger ? "#dc2626" : "#e6178d",
              color: "white",
            }}
          >
            {state.confirmLabel ?? (state.type === "confirm" ? "Confirm" : "OK")}
          </button>
        </div>
      </div>
    </>
  ) : null;

  return { confirm, alert, modal };
}
