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
};

export default function SalesSettingsPage() {
  const { profile } = useCampusFilter();
  const { confirm, modal: dialogModal } = useDialog();
  const isTrueAdmin = profile?.role === "admin";

  const [settings, setSettings] = useState<Settings | null>(null);
  const [sources, setSources] = useState<SalesSource[]>([]);
  const [newSource, setNewSource] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [{ data }, ss] = await Promise.all([
      supabase.from("sales_settings").select("*").eq("id", true).maybeSingle(),
      fetchSources(),
    ]);
    if (data) setSettings(data as Settings);
    setSources(ss);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    const { error } = await supabase.from("sales_settings").update(patch).eq("id", true);
    setStatus(error ? "Save error: " + error.message : "✅ Saved.");
  }

  async function callMailchimp(mode: "test" | "sync") {
    setBusy(true);
    setStatus(mode === "test" ? "Testing…" : "Syncing…");
    try {
      const { data, error } = await supabase.functions.invoke("sales-mailchimp-sync", { body: { mode } });
      if (error) throw error;
      const d = data as Record<string, unknown>;
      if (d?.error) setStatus(`Mailchimp: ${String(d.error)}`);
      else if (mode === "test") setStatus(`✅ Connected (${String(d.server_prefix ?? "")}).`);
      else setStatus(`✅ Synced ${String(d.synced ?? 0)}, failed ${String(d.failed ?? 0)}.`);
      await reload();
    } catch (e) {
      setStatus("Mailchimp error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
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

  if (profile && !isTrueAdmin) {
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

      {/* ── Mailchimp ───────────────────────────────────────────────────── */}
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Mailchimp</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          Pushes leads into an audience as contacts. The API key is stored as a function secret, not here —
          set it with <code>supabase secrets set MAILCHIMP_API_KEY=…</code> before turning this on.
        </div>

        {settings && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
              <div>
                <label style={lbl}>Server prefix</label>
                <input
                  className="input"
                  placeholder="us14"
                  defaultValue={settings.mailchimp_server_prefix ?? ""}
                  onBlur={(e) => void saveSettings({ mailchimp_server_prefix: e.target.value.trim() || null })}
                />
              </div>
              <div>
                <label style={lbl}>Audience (list) ID</label>
                <input
                  className="input"
                  placeholder="a1b2c3d4e5"
                  defaultValue={settings.mailchimp_audience_id ?? ""}
                  onBlur={(e) => void saveSettings({ mailchimp_audience_id: e.target.value.trim() || null })}
                />
              </div>
              <div>
                <label style={lbl}>How new contacts are added</label>
                <select
                  className="select"
                  value={settings.mailchimp_status_if_new}
                  onChange={(e) => void saveSettings({ mailchimp_status_if_new: e.target.value as Settings["mailchimp_status_if_new"] })}
                >
                  <option value="transactional">On the list, but not receiving campaigns</option>
                  <option value="pending">Ask them to confirm (double opt-in)</option>
                  <option value="subscribed">Subscribed straight away</option>
                </select>
                <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
                  Only affects people who aren’t on the list yet — existing subscribers are never changed.
                </div>
              </div>
              <div>
                <label style={lbl}>Tag applied to synced contacts</label>
                <input
                  className="input"
                  defaultValue={settings.mailchimp_tag}
                  onBlur={(e) => void saveSettings({ mailchimp_tag: e.target.value.trim() || "CRM Lead" })}
                />
              </div>
              <div>
                <label style={lbl}>Sync which leads</label>
                <div className="row" style={{ gap: 10, flexWrap: "wrap", paddingTop: 6 }}>
                  {(["active", "enrolled", "inactive"] as const).map((s) => {
                    const on = settings.mailchimp_sync_statuses?.includes(s);
                    return (
                      <label key={s} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={!!on}
                          onChange={(e) => {
                            const cur = new Set(settings.mailchimp_sync_statuses ?? []);
                            if (e.target.checked) cur.add(s); else cur.delete(s);
                            void saveSettings({ mailchimp_sync_statuses: [...cur] });
                          }}
                        />
                        {s}
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="row" style={{ gap: 10, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", fontWeight: 700, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={settings.mailchimp_enabled}
                  onChange={(e) => void saveSettings({ mailchimp_enabled: e.target.checked })}
                />
                Enabled
              </label>
              <button className="btn" disabled={busy} onClick={() => void callMailchimp("test")}>Test connection</button>
              <button
                className="btn"
                disabled={busy || !settings.mailchimp_enabled}
                onClick={async () => {
                  const ok = await confirm(
                    "Push all matching leads to the Mailchimp audience?\n\nNew contacts are added as “transactional”, never auto-subscribed.",
                    { title: "Sync to Mailchimp", confirmLabel: "Sync" }
                  );
                  if (ok) void callMailchimp("sync");
                }}
              >
                Sync now
              </button>
            </div>

            {settings.mailchimp_last_sync_at && (
              <div className="subtle" style={{ fontSize: 12, marginTop: 10 }}>
                Last sync {new Date(settings.mailchimp_last_sync_at).toLocaleString()} — {settings.mailchimp_last_result}
              </div>
            )}
          </>
        )}
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
