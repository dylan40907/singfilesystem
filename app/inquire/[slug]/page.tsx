"use client";

/**
 * Public enquiry form, embedded in singinchinese.com through a Squarespace
 * Code Block — the replacement for their form blocks, which can't post to us.
 *
 * Renders whatever `fields` the form row describes, so new questions are a row
 * edit rather than a deploy. Deliberately plain and self-contained: it sits
 * inside someone else's page, so it inherits nothing and imposes nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/inquiries-public`;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const PINK = "#e6178d";

type Field = {
  key: string;
  label: string;
  type: "text" | "email" | "tel" | "date" | "select" | "textarea" | "checkbox" | "heading";
  required?: boolean;
  half?: boolean;
  options?: string[];
  placeholder?: string;
};

type FormDef = {
  slug: string;
  name: string;
  headline: string | null;
  intro: string | null;
  fields: Field[];
  submit_label: string;
  thank_you: string;
};

async function callFn(body: Record<string, unknown>) {
  const res = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Something went wrong (${res.status}).`);
  return data;
}

export default function InquiryFormPage() {
  const slug = String(useParams()?.slug ?? "");
  const [form, setForm] = useState<FormDef | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [website, setWebsite] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * Embedding needs a Squarespace Business plan, so this page has to work as a
   * standalone destination too — a plain link from any plan. Bare and
   * transparent inside an iframe so it inherits the host page; branded and
   * centred when it *is* the page.
   */
  const [embedded, setEmbedded] = useState(true);
  useEffect(() => { setEmbedded(window.self !== window.top); }, []);

  useEffect(() => {
    callFn({ mode: "form", slug })
      .then((d) => setForm(d.form as FormDef))
      .catch((e) => setError((e as Error).message));
  }, [slug]);

  /**
   * An iframe can't size itself, so tell the parent page how tall we are and
   * let its snippet resize us. Without this the form is stuck in a short box
   * with its own scrollbar.
   */
  const postHeight = useCallback(() => {
    const h = rootRef.current?.scrollHeight ?? 0;
    if (h) window.parent?.postMessage({ type: "sic-inquiry-height", height: h }, "*");
  }, []);

  useEffect(() => {
    postHeight();
    const ro = new ResizeObserver(postHeight);
    if (rootRef.current) ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, [postHeight, form, done, error]);

  function set(key: string, value: string | boolean) {
    setAnswers((a) => ({ ...a, [key]: value }));
  }

  async function submit() {
    if (!form || busy) return;
    // Name the first missing field rather than a generic "check the form".
    const missing = form.fields.find(
      (f) => f.type !== "heading" && f.required && f.type !== "checkbox" && !String(answers[f.key] ?? "").trim()
    );
    if (missing) { setError(`Please fill in "${missing.label}".`); return; }

    setBusy(true);
    setError("");
    try {
      const out = await callFn({ mode: "submit", slug, answers, website });
      setDone(out.thank_you ?? form.thank_you);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !form) {
    return <Shell innerRef={rootRef} embedded={embedded}><p style={{ color: "#b91c1c" }}>{error}</p></Shell>;
  }
  if (!form) {
    return <Shell innerRef={rootRef} embedded={embedded}><p style={{ color: "#9ca3af" }}>Loading…</p></Shell>;
  }
  if (done) {
    return (
      <Shell innerRef={rootRef} embedded={embedded}>
        <h2 style={h2}>Thank you</h2>
        <p style={{ color: "#4b5563", fontSize: 16, lineHeight: 1.6 }}>{done}</p>
      </Shell>
    );
  }

  return (
    <Shell innerRef={rootRef} embedded={embedded}>
      {form.headline && <h2 style={h2}>{form.headline}</h2>}
      {form.intro && <p style={{ color: "#6b7280", margin: "0 0 22px", fontSize: 15 }}>{form.intro}</p>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        {form.fields.map((f) => (
          <div key={f.key} style={{ flex: f.half ? "1 1 calc(50% - 7px)" : "1 1 100%", minWidth: 200 }}>
            {f.type === "heading" ? (
              <div style={{ fontSize: 15, fontWeight: 600, color: "#374151", marginTop: 6 }}>{f.label}</div>
            ) : f.type === "checkbox" ? (
              <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 15, color: "#374151", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!!answers[f.key]}
                  onChange={(e) => set(f.key, e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: PINK }}
                />
                {f.label}
              </label>
            ) : (
              <>
                <label style={labelStyle}>
                  {f.label}
                  {f.required && <span style={{ color: "#9ca3af", marginLeft: 6, fontWeight: 400 }}>(REQUIRED)</span>}
                </label>
                {f.type === "select" ? (
                  <select
                    value={String(answers[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                    style={input}
                  >
                    <option value="">Select an option</option>
                    {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.type === "textarea" ? (
                  <textarea
                    value={String(answers[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    style={{ ...input, minHeight: 96, resize: "vertical" }}
                  />
                ) : (
                  <input
                    type={f.type}
                    value={String(answers[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    style={input}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* Hidden from people, tempting to bots. */}
      <input
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }}
      />

      {error && (
        <p style={{ color: "#b91c1c", fontSize: 14, marginTop: 16, fontWeight: 600 }}>{error}</p>
      )}

      <button onClick={() => void submit()} disabled={busy} style={cta}>
        {busy ? "Sending…" : form.submit_label}
      </button>
    </Shell>
  );
}

function Shell({
  children, innerRef, embedded,
}: {
  children: React.ReactNode;
  innerRef: React.RefObject<HTMLDivElement | null>;
  embedded: boolean;
}) {
  const inner = (
    <div
      ref={innerRef}
      style={{
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        background: "transparent",
        padding: embedded ? "8px 4px 28px" : "8px 4px 12px",
        maxWidth: 640,
        margin: embedded ? undefined : "0 auto",
      }}
    >
      {children}
    </div>
  );

  if (embedded) return inner;

  // Standalone: give it enough of a frame to stand on its own as a real page.
  return (
    <div style={{ minHeight: "100vh", background: "#fff", padding: "28px 18px 56px" }}>
      <div style={{ maxWidth: 640, margin: "0 auto 18px", textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Sing in Chinese" style={{ height: 62, objectFit: "contain" }} />
      </div>
      {inner}
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 26, fontWeight: 700, color: "#2AA9A0", margin: "0 0 8px" };
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "#6b7280", marginBottom: 5,
};
const input: React.CSSProperties = {
  width: "100%", padding: "10px 12px", fontSize: 15, color: "#111827",
  border: "none", borderBottom: "1.5px solid #d1d5db", borderRadius: 0,
  background: "transparent", outline: "none", boxSizing: "border-box",
};
const cta: React.CSSProperties = {
  marginTop: 26, padding: "13px 34px", background: PINK, color: "#fff",
  border: "none", borderRadius: 6, fontSize: 16, fontWeight: 700, cursor: "pointer",
};
