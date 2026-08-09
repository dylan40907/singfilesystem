"use client";

/**
 * Sales → Emails.
 *
 * Every message the booking flow sends, editable in place. Placeholders that
 * carry a link the family needs (manage, book again, the Meet room) are locked
 * chips rather than typed text, and a save is refused if one has gone missing —
 * a confirmation without its manage link leaves a family with no way out.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import RichTextEditor from "@/components/courses/RichTextEditor";
import {
  EMAIL_TEMPLATES,
  EmailAttachment,
  EmailTemplateRow,
  fromEditorHtml,
  missingRequired,
  specFor,
  toEditorHtml,
  uploadEmailAsset,
  deleteEmailAsset,
} from "@/lib/salesEmails";

const GROUPS = ["Tours", "Consultations", "Staff"] as const;

export default function SalesEmailsPage() {
  const { profile } = useCampusFilter();
  const { confirm, alert, modal: dialogModal } = useDialog();
  const isTrueAdmin = profile?.role === "admin";

  const [rows, setRows] = useState<EmailTemplateRow[]>([]);
  const [activeKey, setActiveKey] = useState<string>("tour_requested");
  const [subject, setSubject] = useState("");
  const [editorHtml, setEditorHtml] = useState("");
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const [testTo, setTestTo] = useState("");

  const spec = specFor(activeKey);
  const active = rows.find((r) => r.key === activeKey) ?? null;

  const reload = useCallback(async () => {
    const { data } = await supabase.from("sales_email_templates").select("*").order("key");
    setRows((data as EmailTemplateRow[]) ?? []);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      setTestTo(data.user?.email ?? "");
    })();
  }, []);

  // Load the selected template into the editor. Guarded on key + row identity so
  // a save (which refetches) doesn't stomp on what's on screen.
  useEffect(() => {
    const row = rows.find((r) => r.key === activeKey);
    if (!row) return;
    setSubject(row.subject);
    setEditorHtml(toEditorHtml(row.body_html, specFor(activeKey)));
    setAttachments(Array.isArray(row.attachments) ? row.attachments : []);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, rows.length]);

  const storedHtml = useMemo(() => fromEditorHtml(editorHtml), [editorHtml]);
  const missing = useMemo(
    () => missingRequired(activeKey, subject, storedHtml),
    [activeKey, subject, storedHtml]
  );

  async function save() {
    if (!active) return;
    if (missing.length) {
      await alert(
        `This email still needs: ${missing.map((m) => m.label).join(", ")}. ` +
        `Add it back with the “+ Insert…” menu before saving.`,
        { title: "Missing a required placeholder" }
      );
      return;
    }
    setBusy("save");
    const { data: me } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("sales_email_templates")
      .update({ subject, body_html: storedHtml, attachments, updated_by: me.user?.id ?? null })
      .eq("key", activeKey);
    setBusy("");
    if (error) { setStatus("Save error: " + error.message); return; }
    setStatus("✅ Saved.");
    setDirty(false);
    await reload();
  }

  async function addAttachment(file: File) {
    setBusy("attach");
    try {
      const { path } = await uploadEmailAsset(file);
      setAttachments((a) => [...a, { path, filename: file.name, size: file.size, mime: file.type || "application/octet-stream" }]);
      setDirty(true);
      setStatus("Attachment added — remember to save.");
    } catch (e) {
      setStatus("Upload failed: " + (e instanceof Error ? e.message : "unknown"));
    } finally {
      setBusy("");
    }
  }

  async function removeAttachment(a: EmailAttachment) {
    const ok = await confirm(`Remove ${a.filename} from this email?`, { title: "Remove attachment", danger: true });
    if (!ok) return;
    setAttachments((list) => list.filter((x) => x.path !== a.path));
    setDirty(true);
    await deleteEmailAsset(a.path);
  }

  async function sendTest() {
    const to = testTo.trim();
    if (!to.includes("@")) { setStatus("Enter an address to send the test to."); return; }
    if (dirty) { setStatus("Save first — the test sends what's stored."); return; }
    setBusy("test");
    const { data: sess } = await supabase.auth.getSession();
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tours-public`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sess.session?.access_token ?? ""}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      },
      body: JSON.stringify({ mode: "test_send", key: activeKey, to }),
    });
    const out = await res.json().catch(() => ({}));
    setBusy("");
    setStatus(res.ok ? `✅ Test sent to ${to}.` : `Test failed: ${out?.error ?? res.status}`);
  }

  if (profile && !isTrueAdmin) {
    return (
      <main className="stack">
        <h1 className="h1">Emails</h1>
        <div className="card">Only full admins can edit the sales emails.</div>
      </main>
    );
  }

  return (
    <main className="stack">
      {dialogModal}
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <Link href="/admin/sales" className="btn" style={{ padding: "4px 10px" }}>← Leads</Link>
          <h1 className="h1" style={{ margin: 0 }}>Emails</h1>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      <div className="subtle" style={{ fontSize: 13 }}>
        These are the exact messages sent by the tour and consultation booking pages. Pink chips are
        placeholders — they&apos;re filled in per booking and can&apos;t be typed by hand.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(200px, 240px) 1fr", gap: 14, alignItems: "start" }}>
        {/* Which email */}
        <div className="card" style={{ padding: 10, display: "grid", gap: 12 }}>
          {GROUPS.map((g) => {
            const specs = EMAIL_TEMPLATES.filter((t) => t.group === g);
            if (specs.length === 0) return null;
            return (
              <div key={g}>
                <div className="subtle" style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", margin: "0 0 6px 4px" }}>
                  {g}
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {specs.map((s) => {
                    const row = rows.find((r) => r.key === s.key);
                    const on = s.key === activeKey;
                    return (
                      <button
                        key={s.key}
                        onClick={() => setActiveKey(s.key)}
                        style={{
                          textAlign: "left", padding: "8px 10px", borderRadius: 9, cursor: "pointer",
                          border: on ? "1.5px solid #e6178d" : "1.5px solid transparent",
                          background: on ? "rgba(230,23,141,0.07)" : "transparent",
                          color: on ? "#9d174d" : "#374151", fontWeight: on ? 800 : 600, fontSize: 13,
                        }}
                      >
                        {row?.name ?? s.key}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Editor */}
        <div className="card" style={{ display: "grid", gap: 12 }}>
          {!active ? (
            <div className="subtle">Loading…</div>
          ) : (
            <>
              <div>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{active.name}</div>
                {active.description && (
                  <div className="subtle" style={{ fontSize: 13, marginTop: 3 }}>{active.description}</div>
                )}
              </div>

              <div>
                <label style={lbl}>Subject</label>
                <input
                  className="input"
                  value={subject}
                  onChange={(e) => { setSubject(e.target.value); setDirty(true); }}
                />
                <div className="subtle" style={{ fontSize: 12, marginTop: 5 }}>
                  Placeholders work here too — type them as{" "}
                  {spec?.tokens.slice(0, 3).map((t) => <code key={t.key} style={{ marginRight: 6 }}>{`{{${t.key}}}`}</code>)}
                </div>
              </div>

              <div>
                <label style={lbl}>Body</label>
                <RichTextEditor
                  value={editorHtml}
                  onChange={(html) => { setEditorHtml(html); setDirty(true); }}
                  upload={async (f) => ({ url: (await uploadEmailAsset(f)).url })}
                  tokens={spec?.tokens}
                  minHeight={240}
                  maxHeight={520}
                />
              </div>

              {missing.length > 0 && (
                <div style={{ padding: "10px 14px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13, fontWeight: 700 }}>
                  Missing required placeholder{missing.length > 1 ? "s" : ""}:{" "}
                  {missing.map((m) => m.label).join(", ")}. Put {missing.length > 1 ? "them" : "it"} back
                  with the “+ Insert…” menu — this email can&apos;t be saved without {missing.length > 1 ? "them" : "it"}.
                </div>
              )}

              {/* Attachments */}
              <div>
                <label style={lbl}>Attachments</label>
                <div className="subtle" style={{ fontSize: 12, marginBottom: 8 }}>
                  Sent with every copy of this email. Calendar invites are added automatically and aren&apos;t listed here.
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  {attachments.map((a) => (
                    <div key={a.path} className="row" style={{ gap: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>📎 {a.filename}</span>
                      <span className="subtle" style={{ fontSize: 12 }}>{Math.max(1, Math.round(a.size / 1024))} KB</span>
                      <button className="btn" style={{ padding: "2px 9px", fontSize: 12, color: "#b91c1c" }} onClick={() => void removeAttachment(a)}>
                        Remove
                      </button>
                    </div>
                  ))}
                  {attachments.length === 0 && <div className="subtle" style={{ fontSize: 13 }}>None.</div>}
                </div>
                <label className="btn" style={{ marginTop: 8, display: "inline-flex", cursor: "pointer" }}>
                  {busy === "attach" ? "Uploading…" : "+ Add attachment"}
                  <input
                    type="file"
                    style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addAttachment(f); }}
                  />
                </label>
              </div>

              <div className="row-between" style={{ flexWrap: "wrap", gap: 10, borderTop: "1px solid #e5e7eb", paddingTop: 12 }}>
                <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    className="input"
                    style={{ maxWidth: 240 }}
                    value={testTo}
                    onChange={(e) => setTestTo(e.target.value)}
                    placeholder="you@example.com"
                  />
                  <button className="btn" onClick={() => void sendTest()} disabled={busy === "test"}>
                    {busy === "test" ? "Sending…" : "Send test"}
                  </button>
                  <span className="subtle" style={{ fontSize: 12 }}>Placeholders are filled with sample values.</span>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => void save()}
                  disabled={busy === "save" || !dirty || missing.length > 0}
                >
                  {busy === "save" ? "Saving…" : dirty ? "Save changes" : "Saved"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#6b7280", margin: "0 0 6px" };
