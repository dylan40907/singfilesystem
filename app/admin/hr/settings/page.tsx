"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type HrSettingsRow = {
  id: true;
  admin_email: string | null; // legacy (no longer used)
  reminders_enabled: boolean;
  reminders_time: string; // "HH:MM:SS" from Postgres time
  reminders_tz: string;
  reminders_last_ran_at: string | null;
  created_at: string;
  updated_at: string;
};

type RecipientRow = {
  id: string;
  email: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>{children}</div>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        outline: "none",
        fontSize: 14,
        ...(props.style ?? {}),
      }}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        outline: "none",
        fontSize: 14,
        background: "white",
        ...(props.style ?? {}),
      }}
    />
  );
}

function formatTimeToHHMM(time: string) {
  // "09:00:00" -> "09:00"
  if (!time) return "09:00";
  const parts = time.split(":");
  if (parts.length >= 2) return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
  return "09:00";
}

function normalizeHHMMToDB(timeHHMM: string) {
  // "09:00" -> "09:00:00"
  const [h, m] = timeHHMM.split(":");
  const hh = (h ?? "09").padStart(2, "0");
  const mm = (m ?? "00").padStart(2, "0");
  return `${hh}:${mm}:00`;
}

function isValidEmail(email: string) {
  // simple sanity check (enough for UI)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export default function HrSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [row, setRow] = useState<HrSettingsRow | null>(null);

  // reminder form state
  const [remEnabled, setRemEnabled] = useState(true);
  const [remTimeHHMM, setRemTimeHHMM] = useState("09:00");
  const [remTz, setRemTz] = useState("America/Los_Angeles");

  // recipients state
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [recipientsBusyId, setRecipientsBusyId] = useState<string | null>(null);
  const [addingRecipient, setAddingRecipient] = useState(false);

  const tzOptions = useMemo(
    () => ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "UTC"],
    []
  );

  async function load() {
    setLoading(true);
    setError(null);

    try {
      const { data, error } = await supabase.from("hr_settings").select("*").eq("id", true).single();
      if (error) throw error;

      const r = data as HrSettingsRow;
      setRow(r);

      setRemEnabled(!!r.reminders_enabled);
      setRemTimeHHMM(formatTimeToHHMM(r.reminders_time));
      setRemTz(r.reminders_tz || "America/Los_Angeles");

      const { data: recData, error: recErr } = await supabase
        .from("hr_admin_notifications_recipients")
        .select("id, email, is_enabled, created_at, updated_at")
        .order("created_at", { ascending: true });

      if (recErr) throw recErr;
      setRecipients((recData ?? []) as RecipientRow[]);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load HR settings.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveReminderSettings() {
    setSaving(true);
    setError(null);

    try {
      const payload = {
        reminders_enabled: !!remEnabled,
        reminders_time: normalizeHHMMToDB(remTimeHHMM),
        reminders_tz: remTz.trim() || "America/Los_Angeles",
      };

      const { error } = await supabase.from("hr_settings").update(payload).eq("id", true);
      if (error) throw error;

      await load();
    } catch (e: any) {
      setError(e?.message ?? "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  async function addRecipient() {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;

    if (!isValidEmail(email)) {
      setError("Please enter a valid email address.");
      return;
    }

    setAddingRecipient(true);
    setError(null);

    try {
      const { error } = await supabase.from("hr_admin_notifications_recipients").insert({
        email,
        is_enabled: true,
      });

      if (error) throw error;

      setNewEmail("");
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Failed to add recipient.");
    } finally {
      setAddingRecipient(false);
    }
  }

  async function toggleRecipient(id: string, next: boolean) {
    setRecipientsBusyId(id);
    setError(null);

    try {
      const { error } = await supabase
        .from("hr_admin_notifications_recipients")
        .update({ is_enabled: next })
        .eq("id", id);

      if (error) throw error;
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Failed to update recipient.");
    } finally {
      setRecipientsBusyId(null);
    }
  }

  async function deleteRecipient(id: string) {
    if (!confirm("Delete this recipient?")) return;

    setRecipientsBusyId(id);
    setError(null);

    try {
      const { error } = await supabase.from("hr_admin_notifications_recipients").delete().eq("id", id);
      if (error) throw error;
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete recipient.");
    } finally {
      setRecipientsBusyId(null);
    }
  }

  return (
    <div style={{ paddingTop: 8 }}>
      <div className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
        <div>
          <h1 style={{ margin: "8px 0 6px 0" }}>HR Settings</h1>
          <p className="subtle" style={{ marginTop: 0 }}>
            Admin-only settings for reminder emails and notification recipients.
          </p>
        </div>

        <div className="row" style={{ gap: 10 }}>
          <button className="btn" onClick={() => void load()} disabled={loading || saving || addingRecipient}>
            {loading ? "Loading..." : "Refresh"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void saveReminderSettings()}
            disabled={loading || saving || addingRecipient}
          >
            {saving ? "Saving..." : "Save reminder settings"}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(239,68,68,0.35)",
            background: "rgba(239,68,68,0.06)",
            color: "#991b1b",
            fontWeight: 700,
          }}
        >
          {error}
        </div>
      )}

      {/* Recipients */}
      <div style={{ marginTop: 14, border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid #e5e7eb", fontWeight: 900 }}>
          Notification Recipients
        </div>

        {loading ? (
          <div style={{ padding: 14 }} className="subtle">
            Loading…
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "end" }}>
              <div>
                <FieldLabel>Add recipient email</FieldLabel>
                <TextInput
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="e.g., admin@singinchinese.com"
                />
              </div>
              <button className="btn btn-primary" onClick={() => void addRecipient()} disabled={addingRecipient}>
                {addingRecipient ? "Adding..." : "Add"}
              </button>
            </div>

            <div style={{ marginTop: 12, borderTop: "1px solid #eef2f7" }} />

            {recipients.length === 0 ? (
              <div className="subtle" style={{ paddingTop: 12 }}>
                No recipients yet. Add at least one email above.
              </div>
            ) : (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {recipients.map((r) => {
                  const busy = recipientsBusyId === r.id;
                  return (
                    <div
                      key={r.id}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 14,
                        padding: 12,
                        display: "grid",
                        gridTemplateColumns: "1fr auto auto",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 900 }}>{r.email}</div>
                        <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
                          Created: {new Date(r.created_at).toLocaleString()}
                        </div>
                      </div>

                      <button
                        className="btn"
                        onClick={() => void toggleRecipient(r.id, !r.is_enabled)}
                        disabled={busy}
                        title="Enable/Disable"
                      >
                        {r.is_enabled ? "Enabled" : "Disabled"}
                      </button>

                      <button className="btn" onClick={() => void deleteRecipient(r.id)} disabled={busy}>
                        Delete
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="subtle" style={{ marginTop: 10 }}>
              Reminders will be sent to all recipients marked <b>Enabled</b>.
            </div>
          </div>
        )}
      </div>

      {/* Reminder schedule */}
      <div style={{ marginTop: 14, border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid #e5e7eb", fontWeight: 900 }}>Reminder Schedule</div>

        {loading ? (
          <div style={{ padding: 14 }} className="subtle">
            Loading…
          </div>
        ) : (
          <div style={{ padding: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <FieldLabel>Reminders enabled</FieldLabel>
                <Select value={remEnabled ? "yes" : "no"} onChange={(e) => setRemEnabled(e.target.value === "yes")}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </Select>
              </div>

              <div>
                <FieldLabel>Reminder send time (local)</FieldLabel>
                <TextInput type="time" value={remTimeHHMM} onChange={(e) => setRemTimeHHMM(e.target.value)} />
              </div>

              <div>
                <FieldLabel>Timezone</FieldLabel>
                <Select value={remTz} onChange={(e) => setRemTz(e.target.value)}>
                  {tzOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <FieldLabel>Last reminder run</FieldLabel>
                <TextInput
                  value={row?.reminders_last_ran_at ? new Date(row.reminders_last_ran_at).toLocaleString() : "—"}
                  readOnly
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
