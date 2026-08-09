"use client";

import { useCallback, useState } from "react";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

type DialogState = {
  type: "confirm" | "alert" | "prompt";
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  placeholder?: string;
  resolve: (value: boolean) => void;
} | null;

/**
 * Drop-in replacement for window.confirm(), window.alert() and window.prompt()
 * using custom modals.
 *
 * Usage:
 *   const { confirm, alert, prompt, modal } = useDialog();
 *   // add {modal} to your JSX
 *   const ok = await confirm("Are you sure?");
 *   await alert("Something went wrong.");
 *   const name = await prompt("Name this album");   // null if cancelled
 */
export function useDialog() {
  const [state, setState] = useState<DialogState>(null);
  const [text, setText] = useState("");
  // Set alongside `state` for prompts so `close` can hand back the typed value.
  const [promptResolve, setPromptResolve] = useState<((v: string | null) => void) | null>(null);

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

  /** Resolves to the typed text, or null if cancelled or left blank. */
  const prompt = useCallback(
    (
      message: string,
      opts: { title?: string; confirmLabel?: string; cancelLabel?: string; defaultValue?: string; placeholder?: string } = {}
    ): Promise<string | null> =>
      new Promise((resolve) => {
        setText(opts.defaultValue ?? "");
        setPromptResolve(() => resolve);
        setState({
          type: "prompt",
          message,
          title: opts.title,
          confirmLabel: opts.confirmLabel ?? "OK",
          cancelLabel: opts.cancelLabel,
          placeholder: opts.placeholder,
          // Unused for prompts — promptResolve carries the value.
          resolve: () => {},
        });
      }),
    []
  );

  function close(value: boolean) {
    if (state?.type === "prompt") {
      const v = text.trim();
      promptResolve?.(value && v ? v : null);
      setPromptResolve(null);
      setText("");
    } else {
      state?.resolve(value);
    }
    setState(null);
  }

  // Escape dismisses the dialog (cancels a confirm or prompt, closes an alert).
  useEscapeKey(() => close(false), !!state);

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
        {state.type === "prompt" && (
          <input
            autoFocus
            value={text}
            placeholder={state.placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); close(true); } }}
            style={{
              width: "100%", marginTop: 12, padding: "10px 12px", fontSize: 14,
              borderRadius: 10, border: "1.5px solid #e5e7eb", outline: "none", boxSizing: "border-box",
            }}
          />
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 20, justifyContent: "flex-end" }}>
          {state.type !== "alert" && (
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

  return { confirm, alert, prompt, modal };
}
