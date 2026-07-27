"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import {
  ACTION_TYPE_LABEL,
  ACTIVITY_KIND_LABEL,
  ActionType,
  ActivityKind,
  FIRST_CONTACT_LABEL,
  FirstContactType,
  PREFERRED_LANGUAGES,
  SALES_STATUS_LABEL,
  TIME_ZONES,
  SalesActivity,
  SalesLeadFull,
  SalesSource,
  SalesStatus,
  addActivity,
  addChild,
  clearNextAction,
  deleteActivity,
  deleteChild,
  deleteLead,
  fetchActivities,
  fetchAssignableStaff,
  fetchHousehold,
  fetchLead,
  fetchSources,
  isAwkwardHourFor,
  leadName,
  localTimeFor,
  nextActionState,
  setLeadStatus,
  setNextAction,
  sourceWantsReferrer,
  splitChildToNewLead,
  todayLocal,
  updateChild,
  updateLead,
} from "@/lib/sales";

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return `${m}/${day}/${y}`;
}

export default function SalesLeadPage() {
  const params = useParams<{ id: string }>();
  const leadId = params?.id as string;
  const router = useRouter();
  const { confirm, modal: dialogModal } = useDialog();
  const { campuses, profile } = useCampusFilter();

  const [lead, setLead] = useState<SalesLeadFull | null>(null);
  const [household, setHousehold] = useState<SalesLeadFull[]>([]);
  const [enrollCampusId, setEnrollCampusId] = useState("");
  const [activities, setActivities] = useState<SalesActivity[]>([]);
  const [sources, setSources] = useState<SalesSource[]>([]);
  const [staff, setStaff] = useState<{ id: string; full_name: string | null; role: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [notFound, setNotFound] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<SalesLeadFull>>({});

  // Next action form
  const [naDate, setNaDate] = useState("");
  const [naType, setNaType] = useState<ActionType>("call");
  const [naNote, setNaNote] = useState("");
  const [naBusy, setNaBusy] = useState(false);

  // Log activity form
  const [logKind, setLogKind] = useState<ActivityKind>("call");
  const [logDate, setLogDate] = useState(todayLocal());
  const [logNote, setLogNote] = useState("");
  const [logBusy, setLogBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    try {
      const [l, acts] = await Promise.all([fetchLead(leadId), fetchActivities(leadId)]);
      if (!l) { setNotFound(true); return; }
      setLead(l);
      setActivities(acts);
      setNaDate(l.next_action_date ?? "");
      setNaType(l.next_action_type ?? "call");
      setNaNote(l.next_action_note ?? "");
      // Only one campus in play? Then converting doesn't need to ask which.
      setEnrollCampusId(l.enrolled_campus_id ?? (l.campus_ids.length === 1 ? l.campus_ids[0] : ""));
      setHousehold(await fetchHousehold(l).catch(() => []));
    } catch (e) {
      setStatus("Load error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    (async () => {
      try {
        const [ss, st] = await Promise.all([fetchSources(), fetchAssignableStaff()]);
        setSources(ss);
        setStaff(st);
      } catch { /* non-fatal: the page still works without the pickers */ }
    })();
  }, []);

  const campusLabel = useMemo(() => {
    if (!lead?.campus_ids?.length) return "No campus";
    return lead.campus_ids.map((id) => campuses.find((c) => c.id === id)?.name ?? "?").join(" + ");
  }, [campuses, lead?.campus_ids]);

  const campusNameOf = useCallback(
    (id: string | null) => campuses.find((c) => c.id === id)?.name ?? "—",
    [campuses]
  );

  function beginEdit() {
    if (!lead) return;
    setDraft({ ...lead });
    setEditing(true);
  }

  async function saveEdit() {
    if (!lead) return;
    try {
      await updateLead(lead.id, {
        campus_ids: draft.campus_ids ?? [],
        parent_first_name: (draft.parent_first_name ?? "").trim(),
        parent_last_name: (draft.parent_last_name ?? "").trim(),
        phone: draft.phone?.trim() || null,
        email: draft.email?.trim() || null,
        city: draft.city?.trim() || null,
        time_zone: draft.time_zone?.trim() || null,
        preferred_language: draft.preferred_language?.trim() || null,
        source_id: draft.source_id || null,
        source_other: draft.source_other?.trim() || null,
        referred_by: draft.referred_by?.trim() || null,
        first_contact_type: (draft.first_contact_type as FirstContactType) || null,
        inquiry_date: draft.inquiry_date || todayLocal(),
        desired_start_date: draft.desired_start_date || null,
        desired_start_note: draft.desired_start_note?.trim() || null,
        staff_owner_id: draft.staff_owner_id || null,
        notes: draft.notes?.trim() || null,
      });
      setEditing(false);
      setStatus("✅ Saved.");
      await reload();
    } catch (e) {
      setStatus("Save error: " + ((e as Error)?.message ?? "unknown"));
    }
  }

  async function saveNextAction() {
    if (!lead) return;
    if (!naDate) { setStatus("Pick a date for the next action."); return; }
    if (!naNote.trim()) { setStatus("Add a note for the next action."); return; }
    setNaBusy(true);
    try {
      await setNextAction(lead.id, { date: naDate, type: naType, note: naNote.trim() });
      setStatus("✅ Next action set.");
      await reload();
    } catch (e) {
      setStatus("Error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setNaBusy(false);
    }
  }

  async function logActivity(alsoClearAction: boolean) {
    if (!lead) return;
    if (!logNote.trim()) { setStatus("Write what happened."); return; }
    setLogBusy(true);
    try {
      await addActivity(lead.id, { kind: logKind, note: logNote.trim(), activity_date: logDate });
      if (alsoClearAction) await clearNextAction(lead.id);
      setLogNote("");
      setStatus("✅ Logged.");
      await reload();
    } catch (e) {
      setStatus("Error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setLogBusy(false);
    }
  }

  async function changeStatus(next: SalesStatus) {
    if (!lead) return;
    const reason: string | undefined = undefined;
    if (next === "inactive") {
      const ok = await confirm(
        `Mark ${leadName(lead)} inactive?\n\nThey move to the Inactive tab and follow-up reminders stop.`,
        { title: "Mark inactive", confirmLabel: "Mark inactive" }
      );
      if (!ok) return;
    } else if (next === "enrolled") {
      // Touring both campuses? We must know which one won, or the other campus
      // can't tell a win from a loss.
      if (lead.campus_ids.length > 1 && !enrollCampusId) {
        setStatus("Choose which campus they enrolled at first.");
        return;
      }
      const where = enrollCampusId ? ` at ${campusNameOf(enrollCampusId)}` : "";
      const alsoNote =
        lead.campus_ids.length > 1
          ? `\n\n${campusNameOf(lead.campus_ids.find((c) => c !== enrollCampusId) ?? null)} will see this family as inactive.`
          : "";
      const ok = await confirm(
        `Convert ${leadName(lead)} to enrolled${where}?\n\nThis counts toward the conversion rate and stops follow-up reminders.${alsoNote}`,
        { title: "Convert to enrolled", confirmLabel: "Convert" }
      );
      if (!ok) return;
    }
    try {
      await setLeadStatus(lead.id, next, reason, next === "enrolled" ? enrollCampusId || null : null);
      setStatus(next === "enrolled" ? "🎉 Converted." : next === "inactive" ? "Marked inactive." : "Re-opened.");
      await reload();
    } catch (e) {
      setStatus("Error: " + ((e as Error)?.message ?? "unknown"));
    }
  }

  async function removeLead() {
    if (!lead) return;
    const ok = await confirm(
      `Delete ${leadName(lead)}?\n\nThis permanently removes the lead, its children and its whole follow-up history.`,
      { title: "Delete lead", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    try {
      await deleteLead(lead.id);
      router.push("/admin/sales");
    } catch (e) {
      setStatus("Delete error: " + ((e as Error)?.message ?? "unknown"));
    }
  }

  if (notFound) {
    return (
      <main className="stack">
        <Link href="/admin/sales" className="btn" style={{ alignSelf: "flex-start", padding: "4px 10px" }}>← Leads</Link>
        <div className="card">Lead not found, or you don’t have access to its campus.</div>
      </main>
    );
  }

  if (loading || !lead) {
    return <main className="stack"><div className="subtle">Loading…</div></main>;
  }

  const naState = nextActionState(lead);
  const canEdit = !!profile?.is_active;

  return (
    <main className="stack">
      {dialogModal}

      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Link href="/admin/sales" className="btn" style={{ padding: "4px 10px" }}>← Leads</Link>
          <h1 className="h1" style={{ margin: 0 }}>{leadName(lead)}</h1>
          <span className="badge badge-pink">{SALES_STATUS_LABEL[lead.status]}</span>
          <span className="subtle">{campusLabel}</span>
          {lead.enrolled_campus_id && (
            <span className="subtle">· enrolled at {campusNameOf(lead.enrolled_campus_id)}</span>
          )}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {status ? <span className="badge badge-pink">{status}</span> : null}
          {lead.status !== "enrolled" && lead.campus_ids.length > 1 && (
            <select
              className="select"
              value={enrollCampusId}
              onChange={(e) => setEnrollCampusId(e.target.value)}
              style={{ minWidth: 170 }}
            >
              <option value="">Enrolling at…</option>
              {lead.campus_ids.map((id) => (
                <option key={id} value={id}>{campusNameOf(id)}</option>
              ))}
            </select>
          )}
          {lead.status !== "enrolled" && (
            <button className="btn btn-primary" onClick={() => void changeStatus("enrolled")}>Convert to enrolled</button>
          )}
          {lead.status !== "inactive" && (
            <button className="btn" onClick={() => void changeStatus("inactive")}>Mark inactive</button>
          )}
          {lead.status !== "active" && (
            <button className="btn" onClick={() => void changeStatus("active")}>Re-open as active</button>
          )}
        </div>
      </div>

      {household.length > 0 && (
        <div className="card" style={{ borderColor: "#ddd6fe", background: "#f5f3ff" }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontWeight: 800, color: "#5b21b6" }}>Same family</span>
            {household.map((h) => (
              <Link key={h.id} href={`/admin/sales/${h.id}`} className="btn" style={{ padding: "4px 10px", fontSize: 13 }}>
                {h.children.map((c) => c.name).filter(Boolean).join(", ") || leadName(h)}
                {" · "}
                {SALES_STATUS_LABEL[h.status]}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── Next action ─────────────────────────────────────────────────── */}
      <div
        className="card"
        style={{
          borderColor: naState === "overdue" ? "#fecaca" : naState === "today" ? "#fed7aa" : undefined,
          background: naState === "overdue" ? "#fef2f2" : naState === "today" ? "#fffbeb" : undefined,
        }}
      >
        <div className="row-between" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>Next action</div>
          {lead.next_action_date && (
            <div style={{ fontWeight: 800, color: naState === "overdue" ? "#b91c1c" : naState === "today" ? "#b45309" : "#374151" }}>
              {lead.next_action_type ? ACTION_TYPE_LABEL[lead.next_action_type] : "Follow up"} · {fmtDate(lead.next_action_date)}
              {naState === "overdue" ? " · overdue" : naState === "today" ? " · today" : ""}
            </div>
          )}
        </div>

        {lead.status !== "active" ? (
          <div className="subtle">
            Follow-ups are paused because this lead is {SALES_STATUS_LABEL[lead.status].toLowerCase()}. Re-open it to schedule another.
          </div>
        ) : (
          <>
            {lead.next_action_note && (
              <div style={{ marginBottom: 10, color: "#374151" }}>{lead.next_action_note}</div>
            )}
            <div style={grid3}>
              <div>
                <label style={lbl}>Date</label>
                <input className="input" type="date" value={naDate} onChange={(e) => setNaDate(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Action</label>
                <select className="select" value={naType} onChange={(e) => setNaType(e.target.value as ActionType)}>
                  {(Object.keys(ACTION_TYPE_LABEL) as ActionType[]).map((k) => (
                    <option key={k} value={k}>{ACTION_TYPE_LABEL[k]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Note</label>
                <input className="input" value={naNote} onChange={(e) => setNaNote(e.target.value)} placeholder="What needs doing?" />
              </div>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={() => void saveNextAction()} disabled={naBusy}>
                {naBusy ? "Saving…" : lead.next_action_date ? "Update next action" : "Set next action"}
              </button>
              {lead.next_action_date && (
                <button
                  className="btn"
                  disabled={naBusy}
                  onClick={async () => { await clearNextAction(lead.id); setStatus("Cleared."); await reload(); }}
                >
                  Clear
                </button>
              )}
              <span className="subtle" style={{ fontSize: 12, alignSelf: "center" }}>
                A reminder goes out on the date, and again if nothing gets logged.
              </span>
            </div>
          </>
        )}
      </div>

      {/* ── Details ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="row-between" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>Details</div>
          {canEdit && !editing && <button className="btn" onClick={beginEdit}>Edit</button>}
          {editing && (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => void saveEdit()}>Save</button>
            </div>
          )}
        </div>

        {!editing ? (
          <div style={grid3}>
            <Field label="Phone" value={lead.phone} />
            <Field label="Email" value={lead.email} />
            <Field label="City" value={lead.city} />
            <div>
              <div style={lbl}>Their local time</div>
              {lead.time_zone ? (
                <div style={{ color: isAwkwardHourFor(lead.time_zone) ? "#b45309" : "#111827", fontWeight: isAwkwardHourFor(lead.time_zone) ? 800 : 400 }}>
                  {localTimeFor(lead.time_zone) ?? lead.time_zone}
                  {isAwkwardHourFor(lead.time_zone) && " — bad time to call"}
                  <div className="subtle" style={{ fontSize: 12, fontWeight: 400 }}>
                    {TIME_ZONES.find((t) => t.value === lead.time_zone)?.label ?? lead.time_zone}
                  </div>
                </div>
              ) : (
                <div style={{ color: "#9ca3af" }}>—</div>
              )}
            </div>
            <Field label="Preferred language" value={lead.preferred_language} />
            <Field label="How they heard" value={lead.source?.name ?? lead.source_other} />
            <Field label="Referred by" value={lead.referred_by} />
            <Field label="Call or scheduled tour" value={lead.first_contact_type ? FIRST_CONTACT_LABEL[lead.first_contact_type] : null} />
            <Field label="Inquiry date" value={fmtDate(lead.inquiry_date)} />
            <Field label="Desired start" value={lead.desired_start_date ? fmtDate(lead.desired_start_date) : lead.desired_start_note} />
            <Field label="Owner" value={staff.find((s) => s.id === lead.staff_owner_id)?.full_name ?? lead.staff_name} />
            <Field label="Campus(es)" value={campusLabel} />
            <Field label="Added" value={fmtDate(lead.created_at.slice(0, 10))} />
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Notes" value={lead.notes} multiline />
            </div>
          </div>
        ) : (
          <div style={grid3}>
            <Input label="Parent first name" value={draft.parent_first_name ?? ""} onChange={(v) => setDraft((d) => ({ ...d, parent_first_name: v }))} />
            <Input label="Parent last name" value={draft.parent_last_name ?? ""} onChange={(v) => setDraft((d) => ({ ...d, parent_last_name: v }))} />
            <div>
              <label style={lbl}>Campus(es) they’re considering</label>
              <div className="row" style={{ gap: 12, flexWrap: "wrap", paddingTop: 6 }}>
                {campuses.map((c) => {
                  const on = (draft.campus_ids ?? []).includes(c.id);
                  return (
                    <label key={c.id} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setDraft((d) => {
                            const cur = new Set(d.campus_ids ?? []);
                            if (on) cur.delete(c.id); else cur.add(c.id);
                            return { ...d, campus_ids: [...cur] };
                          })
                        }
                      />
                      {c.name}
                    </label>
                  );
                })}
              </div>
            </div>
            <Input label="Phone" value={draft.phone ?? ""} onChange={(v) => setDraft((d) => ({ ...d, phone: v }))} />
            <Input label="Email" value={draft.email ?? ""} onChange={(v) => setDraft((d) => ({ ...d, email: v }))} />
            <Input label="City" value={draft.city ?? ""} onChange={(v) => setDraft((d) => ({ ...d, city: v }))} />
            <div>
              <label style={lbl}>Time zone</label>
              <select
                className="select"
                value={draft.time_zone ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, time_zone: e.target.value || null }))}
              >
                <option value="">— Not known —</option>
                {TIME_ZONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              {draft.time_zone && (
                <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
                  Right now it’s {localTimeFor(draft.time_zone)} for them.
                </div>
              )}
            </div>
            <div>
              <label style={lbl}>Preferred language</label>
              <select
                className="select"
                value={draft.preferred_language ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, preferred_language: e.target.value || null }))}
              >
                <option value="">— Not known —</option>
                {PREFERRED_LANGUAGES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>How they heard</label>
              <select className="select" value={draft.source_id ?? ""} onChange={(e) => setDraft((d) => ({ ...d, source_id: e.target.value || null }))}>
                <option value="">— Not recorded —</option>
                {sources.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <Input label="Source detail" value={draft.source_other ?? ""} onChange={(v) => setDraft((d) => ({ ...d, source_other: v }))} />
            {sourceWantsReferrer(sources.find((s) => s.id === draft.source_id)?.name) && (
              <Input
                label="Who told them about us?"
                value={draft.referred_by ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, referred_by: v }))}
                placeholder="Name of the family or friend"
              />
            )}
            <div>
              <label style={lbl}>Call or scheduled tour</label>
              <select className="select" value={draft.first_contact_type ?? ""} onChange={(e) => setDraft((d) => ({ ...d, first_contact_type: (e.target.value || null) as FirstContactType }))}>
                <option value="">— Not recorded —</option>
                {(Object.keys(FIRST_CONTACT_LABEL) as FirstContactType[]).map((k) => (
                  <option key={k} value={k}>{FIRST_CONTACT_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={lbl}>Owner</label>
              <select className="select" value={draft.staff_owner_id ?? ""} onChange={(e) => setDraft((d) => ({ ...d, staff_owner_id: e.target.value || null }))}>
                <option value="">— Unassigned (alerts all admins) —</option>
                {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name ?? s.id}</option>)}
              </select>
            </div>
            <Input label="Inquiry date" type="date" value={draft.inquiry_date ?? ""} onChange={(v) => setDraft((d) => ({ ...d, inquiry_date: v }))} />
            <Input label="Desired start date" type="date" value={draft.desired_start_date ?? ""} onChange={(v) => setDraft((d) => ({ ...d, desired_start_date: v }))} />
            <Input label="…or in their words" value={draft.desired_start_note ?? ""} onChange={(v) => setDraft((d) => ({ ...d, desired_start_note: v }))} />
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={lbl}>Notes</label>
              <textarea className="textarea" style={{ minHeight: 90 }} value={draft.notes ?? ""} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
            </div>
          </div>
        )}
      </div>

      <ChildrenCard lead={lead} onChanged={reload} onError={setStatus} onSplit={(id) => router.push(`/admin/sales/${id}`)} />

      {/* ── History ─────────────────────────────────────────────────────── */}
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12 }}>History</div>

        <div style={grid3}>
          <div>
            <label style={lbl}>Date</label>
            <input className="input" type="date" value={logDate} onChange={(e) => setLogDate(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>What happened</label>
            <select className="select" value={logKind} onChange={(e) => setLogKind(e.target.value as ActivityKind)}>
              {(["call", "email", "tour", "text", "note", "other"] as ActivityKind[]).map((k) => (
                <option key={k} value={k}>{ACTIVITY_KIND_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={lbl}>Note</label>
            <input
              className="input"
              value={logNote}
              onChange={(e) => setLogNote(e.target.value)}
              placeholder="Toured with Lynn, will decide by Friday…"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void logActivity(false); } }}
            />
          </div>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => void logActivity(false)} disabled={logBusy}>
            {logBusy ? "Saving…" : "Log it"}
          </button>
          {lead.next_action_date && lead.status === "active" && (
            <button className="btn" onClick={() => void logActivity(true)} disabled={logBusy}>
              Log it &amp; clear the pending action
            </button>
          )}
        </div>

        <div style={{ marginTop: 18 }}>
          {activities.length === 0 ? (
            <div className="subtle">Nothing logged yet.</div>
          ) : (
            <div className="stack" style={{ gap: 0 }}>
              {activities.map((a) => (
                <div key={a.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderTop: "1px solid #f1f5f9" }}>
                  <div style={{ minWidth: 84, color: "#6b7280", fontSize: 13, fontWeight: 700 }}>{fmtDate(a.activity_date)}</div>
                  <div style={{ minWidth: 92 }}>
                    <span style={{ background: "#f3f4f6", color: "#374151", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 999 }}>
                      {ACTIVITY_KIND_LABEL[a.kind]}
                    </span>
                  </div>
                  <div style={{ flex: 1, color: "#374151", whiteSpace: "pre-wrap" }}>{a.note}</div>
                  <button
                    className="btn"
                    style={{ padding: "2px 8px", fontSize: 11, color: "#991b1b" }}
                    onClick={async () => {
                      const ok = await confirm("Delete this history entry?", { title: "Delete entry", confirmLabel: "Delete", danger: true });
                      if (!ok) return;
                      await deleteActivity(a.id);
                      await reload();
                    }}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" style={{ color: "#991b1b" }} onClick={() => void removeLead()}>Delete lead</button>
      </div>
    </main>
  );
}

// ─── Children ────────────────────────────────────────────────────────────────

function ChildrenCard({
  lead, onChanged, onError, onSplit,
}: {
  lead: SalesLeadFull;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
  onSplit: (newLeadId: string) => void;
}) {
  const { confirm, modal } = useDialog();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [dobNote, setDobNote] = useState("");
  const [program, setProgram] = useState("");
  const [schedule, setSchedule] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim() && !program.trim()) { onError("Give the child a name or a program."); return; }
    setBusy(true);
    try {
      await addChild(lead.id, {
        name: name.trim(),
        dob: dob || null,
        dob_note: dobNote.trim() || null,
        program: program.trim() || null,
        schedule: schedule.trim() || null,
        order_index: lead.children.length,
      });
      setName(""); setDob(""); setDobNote(""); setProgram(""); setSchedule("");
      setAdding(false);
      await onChanged();
    } catch (e) {
      onError((e as Error)?.message ?? "Could not add the child.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      {modal}
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 900, fontSize: 15 }}>
          Children <span className="subtle" style={{ fontWeight: 500 }}>({lead.children.length})</span>
        </div>
        {!adding && <button className="btn" onClick={() => setAdding(true)}>+ Add child</button>}
      </div>

      {lead.children.length === 0 && !adding ? (
        <div className="subtle">No children recorded yet.</div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {lead.children.map((c) => (
            <div key={c.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
              <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{c.name || "(unnamed child)"}</div>
                  <div className="subtle" style={{ fontSize: 12 }}>
                    {[
                      c.dob ? `DOB ${fmtDate(c.dob)}` : c.dob_note,
                      c.program,
                      c.schedule,
                      c.chinese_level ? `Chinese: ${c.chinese_level}` : null,
                      c.previous_school ? `Prev: ${c.previous_school}` : null,
                    ].filter(Boolean).join(" · ") || "No details"}
                  </div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    style={{ maxWidth: 190, fontSize: 13 }}
                    defaultValue={c.program ?? ""}
                    placeholder="Program"
                    onBlur={async (e) => {
                      const v = e.target.value.trim();
                      if (v === (c.program ?? "")) return;
                      try { await updateChild(c.id, { program: v || null }); await onChanged(); }
                      catch (err) { onError((err as Error)?.message ?? "Could not update."); }
                    }}
                  />
                  {lead.children.length > 1 && (
                    <button
                      className="btn"
                      style={{ padding: "2px 8px", fontSize: 11 }}
                      title="Track this child as their own lead, still linked to the family"
                      onClick={async () => {
                        const ok = await confirm(
                          `Give ${c.name || "this child"} their own lead?\n\n` +
                            `The parent's details are copied across and both leads stay linked as one family, ` +
                            `so one child can enrol while the other is still deciding.`,
                          { title: "Split into own lead", confirmLabel: "Split" }
                        );
                        if (!ok) return;
                        try {
                          const newId = await splitChildToNewLead(lead, c.id);
                          await onChanged();
                          onSplit(newId);
                        } catch (err) {
                          onError((err as Error)?.message ?? "Could not split the child out.");
                        }
                      }}
                    >
                      Split out
                    </button>
                  )}
                  <button
                    className="btn"
                    style={{ padding: "2px 8px", fontSize: 11, color: "#991b1b" }}
                    onClick={async () => {
                      const ok = await confirm(`Remove ${c.name || "this child"} from the lead?`, { title: "Remove child", confirmLabel: "Remove", danger: true });
                      if (!ok) return;
                      await deleteChild(c.id);
                      await onChanged();
                    }}
                  >
                    🗑
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div style={{ marginTop: 12, borderTop: "1px solid #f1f5f9", paddingTop: 12 }}>
          <div style={grid3}>
            <Input label="Name" value={name} onChange={setName} />
            <Input label="Date of birth" type="date" value={dob} onChange={setDob} />
            <Input label="…or age in words" value={dobNote} onChange={setDobNote} placeholder="22 months" />
            <Input label="Program" value={program} onChange={setProgram} placeholder="Preschool" />
            <Input label="Days / schedule" value={schedule} onChange={setSchedule} placeholder="5 Days/Week" />
          </div>
          <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
            <button className="btn" onClick={() => setAdding(false)} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>{busy ? "Adding…" : "Add child"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Small presentational helpers ────────────────────────────────────────────

function Field({ label, value, multiline }: { label: string; value?: string | null; multiline?: boolean }) {
  return (
    <div>
      <div style={lbl}>{label}</div>
      <div style={{ color: value ? "#111827" : "#9ca3af", whiteSpace: multiline ? "pre-wrap" : undefined }}>
        {value || "—"}
      </div>
    </div>
  );
}

function Input({
  label, value, onChange, type, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label style={lbl}>{label}</label>
      <input className="input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#6b7280", margin: "0 0 6px" };
const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 };
