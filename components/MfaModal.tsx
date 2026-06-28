"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Tokens = { access_token: string; refresh_token: string };

const PINK = "#e6178d";

// US-only: user types 10 digits; we prepend +1 ourselves.
function formatUsPhone(d: string): string {
  const digits = d.replace(/\D/g, "").slice(0, 10);
  const a = digits.slice(0, 3), b = digits.slice(3, 6), c = digits.slice(6, 10);
  if (digits.length > 6) return `(${a}) ${b}-${c}`;
  if (digits.length > 3) return `(${a}) ${b}`;
  if (digits.length > 0) return `(${a}`;
  return "";
}

/**
 * Two-phase SMS verification shown after a password is accepted but before the
 * session is released. Phase "phone" only appears for first-time enrollment;
 * existing users jump straight to "code" (we auto-send on mount).
 */
export default function MfaModal({
  ticket,
  setupRequired,
  maskedPhone,
  onVerified,
  onCancel,
}: {
  ticket: string;
  setupRequired: boolean;
  maskedPhone: string | null;
  onVerified: (tokens: Tokens) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"phone" | "code">(setupRequired ? "phone" : "code");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [masked, setMasked] = useState<string | null>(maskedPhone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const autoSent = useRef(false);

  const sendCode = useCallback(
    async (phoneArg?: string) => {
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const body: Record<string, string> = { ticket };
        if (phoneArg) body.phone = phoneArg;
        const { data, error: fnErr } = await supabase.functions.invoke("mfa-start", { body });
        if (fnErr || (data as any)?.error) {
          setError((data as any)?.error ?? fnErr?.message ?? "Could not send code.");
          return false;
        }
        if ((data as any)?.masked_phone) setMasked((data as any).masked_phone);
        setPhase("code");
        setInfo("We sent a 6-digit code by SMS.");
        return true;
      } catch (e: any) {
        setError(e?.message ?? "Could not send code.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [ticket]
  );

  // Existing users: auto-send to the phone already on file.
  useEffect(() => {
    if (!setupRequired && !autoSent.current) {
      autoSent.current = true;
      sendCode();
    }
  }, [setupRequired, sendCode]);

  async function handleSendPhone() {
    if (phone.length !== 10) {
      setError("Enter your 10-digit US mobile number.");
      return;
    }
    await sendCode(`+1${phone}`);
  }

  async function handleVerify() {
    const c = code.trim();
    if (c.length < 4) {
      setError("Enter the code from the text message.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("mfa-check", {
        body: { ticket, code: c },
      });
      if (fnErr || (data as any)?.error) {
        setError((data as any)?.error ?? fnErr?.message ?? "Verification failed.");
        return;
      }
      const access_token = (data as any)?.access_token;
      const refresh_token = (data as any)?.refresh_token;
      if (!access_token || !refresh_token) {
        setError("Unexpected response. Please sign in again.");
        return;
      }
      onVerified({ access_token, refresh_token });
    } catch (e: any) {
      setError(e?.message ?? "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div style={{ width: "100%", maxWidth: 420, background: "white", borderRadius: 16, padding: 24, boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#111827", marginBottom: 4 }}>
          Two-step verification
        </div>
        <div style={{ fontSize: 14, color: "#6b7280", marginBottom: 18 }}>
          {phase === "phone"
            ? "Add a mobile number to secure your account. We'll text you a verification code."
            : masked
              ? `Enter the 6-digit code we texted to ${masked}.`
              : "Enter the 6-digit code we just texted you."}
        </div>

        {phase === "phone" ? (
          <>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>
              Mobile number
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>+1</span>
              <input
                value={formatUsPhone(phone)}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                placeholder="(555) 123-4567"
                inputMode="numeric"
                autoFocus
                style={{ ...inputStyle, flex: 1 }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSendPhone(); }}
              />
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>
              We&apos;ll text a verification code to your US mobile number.
            </div>
          </>
        ) : (
          <>
            <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 6 }}>
              Verification code
            </label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
              placeholder="123456"
              inputMode="numeric"
              autoFocus
              style={{ ...inputStyle, letterSpacing: 6, fontSize: 20, textAlign: "center" }}
              onKeyDown={(e) => { if (e.key === "Enter") handleVerify(); }}
            />
            <button
              type="button"
              onClick={() => sendCode(setupRequired ? `+1${phone}` : undefined)}
              disabled={busy}
              style={{ marginTop: 8, background: "none", border: "none", color: PINK, fontWeight: 700, fontSize: 13, cursor: busy ? "default" : "pointer", padding: 0 }}
            >
              Resend code
            </button>
          </>
        )}

        {error && <div style={{ marginTop: 12, fontSize: 13, color: "#991b1b", fontWeight: 600 }}>{error}</div>}
        {info && !error && <div style={{ marginTop: 12, fontSize: 13, color: "#047857", fontWeight: 600 }}>{info}</div>}

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={secondaryBtn}>
            Cancel
          </button>
          <button
            type="button"
            onClick={phase === "phone" ? handleSendPhone : handleVerify}
            disabled={busy}
            style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Please wait…" : phase === "phone" ? "Send code" : "Verify"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "12px 14px", borderRadius: 10, border: "1.5px solid #e5e7eb",
  fontSize: 16, outline: "none", boxSizing: "border-box",
};
const primaryBtn: React.CSSProperties = {
  flex: 1, padding: "12px 16px", borderRadius: 10, border: "none", background: PINK,
  color: "white", fontWeight: 800, fontSize: 15, cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  flex: 1, padding: "12px 16px", borderRadius: 10, border: "1.5px solid #e5e7eb",
  background: "white", color: "#374151", fontWeight: 800, fontSize: 15, cursor: "pointer",
};
