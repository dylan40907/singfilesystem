"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import { SalesSource, fetchSources } from "@/lib/sales";

type Settings = {
  mailchimp_enabled: boolean;
  mailchimp_server_prefix: string | null;
  mailchimp_audience_id: string | null;
  mailchimp_sync_statuses: string[];
  mailchimp_status_if_new: "transactional" | "pending" | "subscribed";
  mailchimp_tag: string;
  mailchimp_last_sync_at: string | null;
  mailchimp_last_result: string | null;
  reminder_time: string;
  reminder_tz: string;
};

const REMINDER_ZONES = [
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/New_York", label: "Eastern" },
];

export default function SalesSettingsPage() {
  const { profile, campuses } = useCampusFilter();
  const { modal: dialogModal } = useDialog();
  // Was `role === "admin"`, so a role granted Emails or Sales Settings got a
  // "Not authorized" card. PageAccessGuard has already resolved the grant;
  // both pages default to nobody below admin, so a holder got them on purpose.
  const canUse = !!profile?.is_active;

  const [settings, setSettings] = useState<Settings | null>(null);
  const [sources, setSources] = useState<SalesSource[]>([]);
  const [newSource, setNewSource] = useState("");
  const [status, setStatus] = useState("");
  // Campus addresses live on hr_campuses rather than sales_settings — they
  // belong to the campus, and the booking function reads them from there.
  const [campusEmails, setCampusEmails] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const [{ data }, ss, { data: ce }] = await Promise.all([
      supabase.from("sales_settings").select("*").eq("id", true).maybeSingle(),
      fetchSources(),
      supabase.from("hr_campuses").select("id, contact_email").eq("admissions_only", false),
    ]);
    if (data) setSettings(data as Settings);
    setSources(ss);
    const map: Record<string, string> = {};
    for (const c of (ce ?? []) as { id: string; contact_email: string | null }[]) {
      map[c.id] = c.contact_email ?? "";
    }
    setCampusEmails(map);
  }, []);

  async function saveCampusEmail(campusId: string, raw: string) {
    const value = raw.trim();
    if (value && !value.includes("@")) { setStatus("That doesn't look like an email address."); return; }
    setCampusEmails((m) => ({ ...m, [campusId]: value }));
    const { error } = await supabase
      .from("hr_campuses").update({ contact_email: value || null }).eq("id", campusId);
    setStatus(error ? "Save error: " + error.message : "✅ Saved.");
  }

  useEffect(() => { void reload(); }, [reload]);

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    const { error } = await supabase.from("sales_settings").update(patch).eq("id", true);
    setStatus(error ? "Save error: " + error.message : "✅ Saved.");
  }

  async function addSource() {
    const name = newSource.trim();
    if (!name) return;
    const { error } = await supabase
      .from("sales_lead_sources")
      .insert({ name, order_index: (sources.at(-1)?.order_index ?? 0) + 10 });
    if (error) setStatus("Error: " + error.message);
    else { setNewSource(""); await reload(); }
  }

  async function toggleSource(s: SalesSource) {
    // Deactivate rather than delete: existing leads still point at it, and the
    // conversion report needs the label to stay meaningful.
    const { error } = await supabase
      .from("sales_lead_sources").update({ is_active: !s.is_active }).eq("id", s.id);
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  async function renameSource(s: SalesSource, name: string) {
    if (!name.trim() || name === s.name) return;
    const { error } = await supabase.from("sales_lead_sources").update({ name: name.trim() }).eq("id", s.id);
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  if (profile && !canUse) {
    return (
      <main className="stack">
        <h1 className="h1">Sales settings</h1>
        <div className="card">Only full admins can change Sales settings.</div>
      </main>
    );
  }

  return (
    <main className="stack">
      {dialogModal}
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <Link href="/admin/sales" className="btn" style={{ padding: "4px 10px" }}>← Leads</Link>
          <h1 className="h1" style={{ margin: 0 }}>Sales settings</h1>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      {/* ── Follow-up reminders ─────────────────────────────────────────── */}
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Follow-up reminders</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          On the day a follow-up is due, the assignee and the admins get a notification in the portal and on the
          HR app. If nothing is logged, it repeats every <strong>working</strong> day until it is — a Friday
          reminder comes back on Monday, not at the weekend. No emails are sent.
        </div>

        {settings && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            <div>
              <label style={lbl}>Send reminders at</label>
              <input
                className="input"
                type="time"
                defaultValue={(settings.reminder_time ?? "09:00").slice(0, 5)}
                onBlur={(e) => void saveSettings({ reminder_time: e.target.value || "09:00" })}
              />
            </div>
            <div>
              <label style={lbl}>Time zone</label>
              <select
                className="select"
                value={settings.reminder_tz ?? "America/Los_Angeles"}
                onChange={(e) => void saveSettings({ reminder_tz: e.target.value })}
              >
                {REMINDER_ZONES.map((z) => <option key={z.value} value={z.value}>{z.label}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* ── Campus email addresses ──────────────────────────────────────── */}
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Campus email addresses</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          When a tour or consultation is booked, a copy of the confirmation — with the calendar invite and
          meeting link — goes to the address for that campus. Leave one blank and nobody is emailed for it;
          the portal and app notifications still go out either way.
        </div>

        <div className="stack" style={{ gap: 10 }}>
          {campuses.map((c) => (
            <div key={c.id} className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 800, fontSize: 14, minWidth: 140 }}>{c.name}</span>
              <input
                className="input"
                type="email"
                style={{ maxWidth: 320 }}
                placeholder="torrancepv@singinchinese.com"
                defaultValue={campusEmails[c.id] ?? ""}
                onBlur={(e) => void saveCampusEmail(c.id, e.target.value)}
              />
            </div>
          ))}
          {campuses.length === 0 && <div className="subtle" style={{ fontSize: 13 }}>No campuses yet.</div>}
        </div>
      </div>

      {/* ── Sources ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>“How did you hear about us?”</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          These drive the conversion-by-source report. Turning one off hides it from new leads but keeps it on
          existing ones.
        </div>

        <div className="stack" style={{ gap: 8 }}>
          {sources.map((s) => (
            <div key={s.id} className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                className="input"
                defaultValue={s.name}
                style={{ maxWidth: 280, opacity: s.is_active ? 1 : 0.5 }}
                onBlur={(e) => void renameSource(s, e.target.value)}
              />
              <button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => void toggleSource(s)}>
                {s.is_active ? "Active" : "Hidden"}
              </button>
            </div>
          ))}
        </div>

        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <input
            className="input"
            placeholder="Add a source…"
            value={newSource}
            style={{ maxWidth: 280 }}
            onChange={(e) => setNewSource(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addSource(); }}
          />
          <button className="btn" onClick={() => void addSource()}>Add</button>
        </div>
      </div>

      {/* ── Import ──────────────────────────────────────────────────────── */}
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Import the old inquiry log</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          Load the legacy <code>Inquiry Log.xlsx</code>, review what was parsed, then import.
        </div>
        <Link href="/admin/sales/import" className="btn">Open importer</Link>
      </div>
    </main>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#6b7280", margin: "0 0 6px" };
