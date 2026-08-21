"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import TourAvailabilityEditor, {
  AvailabilityRow, BlackoutRow,
} from "@/components/sales/TourAvailabilityEditor";

/**
 * Sales → Meetings. Online Chinese Classes + Homework Club consultations.
 *
 * Kept apart from Tours because they behave differently: they're confirmed the
 * moment a parent books (there's a standing Meet room, so there's nothing to
 * approve), they never create a sales lead, and they ask their own questions —
 * which live in `answers` rather than as columns.
 */

type TourType = {
  id: string; campus_id: string | null; slug: string; name: string;
  kind: string; meet_url: string | null; time_zone: string;
  duration_minutes: number; min_notice_hours: number; max_days_ahead: number;
};

type Meeting = {
  id: string; tour_type_id: string | null; campus_id: string | null;
  starts_at: string; status: string;
  parent_name: string; parent_email: string; parent_phone: string | null;
  child_name: string | null; child_dob: string | null;
  notes: string | null; answers: Record<string, string> | null;
  cancel_reason: string | null;
};

/** The consultation questions, in the order they're asked. */
const ANSWER_LABELS: [string, string][] = [
  ["chinese_knowledge", "Knows Chinese"],
  ["learning_goals", "Learning goals"],
  ["program_interest", "Program"],
  ["currently_taking_lessons", "Currently taking lessons"],
  ["how_heard", "Heard about us"],
];

export default function SalesMeetingsPage() {
  const { profile, campuses } = useCampusFilter();
  const { confirm, modal: dialogModal } = useDialog();
  // Was a role list, so a role granted a Sales page got "Not authorized".
  // PageAccessGuard in app/admin/sales/layout.tsx decides access now.
  const canUse = !!profile?.is_active;

  const [tab, setTab] = useState<"upcoming" | "past" | "setup">("upcoming");
  const [types, setTypes] = useState<TourType[]>([]);
  const [avail, setAvail] = useState<AvailabilityRow[]>([]);
  const [blackouts, setBlackouts] = useState<BlackoutRow[]>([]);
  const [rows, setRows] = useState<Meeting[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [meetDraft, setMeetDraft] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [t, m, a, bo] = await Promise.all([
        supabase.from("sales_tour_types").select("*").eq("kind", "hwc_consult").order("name"),
        supabase.from("sales_tours").select("*").order("starts_at", { ascending: true }),
        supabase.from("sales_tour_availability").select("*"),
        supabase.from("sales_tour_blackouts").select("*").order("day", { ascending: true }),
      ]);
      const tt = (t.data ?? []) as TourType[];
      const ids = new Set(tt.map((x) => x.id));
      setTypes(tt);
      setAvail(((a.data ?? []) as AvailabilityRow[]).filter((r) => ids.has(r.tour_type_id)));
      setBlackouts(((bo.data ?? []) as BlackoutRow[]).filter((r) => ids.has(r.tour_type_id)));
      setMeetDraft(Object.fromEntries(tt.map((x) => [x.id, x.meet_url ?? ""])));
      // Only consultations belong here — preschool tours live in the Tours tab.
      setRows(((m.data ?? []) as Meeting[]).filter((r) => r.tour_type_id && ids.has(r.tour_type_id)));
      setStatus("");
    } catch (e) {
      setStatus("Load error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (canUse) void reload(); }, [canUse, reload]);

  const now = Date.now();
  const upcoming = useMemo(
    () => rows.filter((r) => r.status !== "cancelled" && new Date(r.starts_at).getTime() >= now),
    [rows, now]
  );
  const past = useMemo(
    () => rows.filter((r) => r.status === "cancelled" || new Date(r.starts_at).getTime() < now)
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
    [rows, now]
  );

  const typeOf = (id: string | null) => types.find((t) => t.id === id) ?? null;
  const campusName = (id: string | null) => campuses.find((c) => c.id === id)?.name ?? "—";
  const fmt = (isoStr: string, tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(isoStr));

  async function saveMeetUrl(typeId: string) {
    const url = (meetDraft[typeId] ?? "").trim();
    const { error } = await supabase.from("sales_tour_types").update({ meet_url: url || null }).eq("id", typeId);
    if (error) setStatus("Error: " + error.message);
    else { setStatus("✅ Meeting link saved."); await reload(); }
  }

  async function addWindow(typeId: string, day: number, start: string, end: string) {
    const { error } = await supabase.from("sales_tour_availability")
      .insert({ tour_type_id: typeId, day_of_week: day, start_time: start, end_time: end });
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  async function removeWindow(id: string) {
    const { error } = await supabase.from("sales_tour_availability").delete().eq("id", id);
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  /** One row per day, so a single day can be reopened without unpicking a week. */
  async function addBlackout(typeId: string, from: string, to: string, reason: string) {
    const days: string[] = [];
    const cur = new Date(`${from}T00:00:00`);
    const last = new Date(`${to || from}T00:00:00`);
    for (let guard = 0; guard < 400 && cur <= last; guard++) {
      // Local parts, not toISOString — that converts to UTC and shifts the day.
      days.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
      cur.setDate(cur.getDate() + 1);
    }
    const already = new Set(blackouts.filter((b) => b.tour_type_id === typeId).map((b) => b.day));
    const insert = days.filter((d) => !already.has(d))
      .map((d) => ({ tour_type_id: typeId, day: d, reason: reason.trim() || null }));
    if (insert.length === 0) { setStatus("Those dates are already closed."); return; }
    const { error } = await supabase.from("sales_tour_blackouts").insert(insert);
    if (error) setStatus("Error: " + error.message);
    else { setStatus(`✅ Closed ${insert.length} day(s).`); await reload(); }
  }

  async function removeBlackout(id: string) {
    const { error } = await supabase.from("sales_tour_blackouts").delete().eq("id", id);
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  async function cancelMeeting(m: Meeting) {
    const ok = await confirm(
      `Cancel ${m.parent_name}'s consultation?\n\nThe slot reopens. They are not emailed automatically — call them if it's short notice.`,
      { title: "Cancel consultation", confirmLabel: "Cancel it", danger: true }
    );
    if (!ok) return;
    const { error } = await supabase.from("sales_tours")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: "staff" })
      .eq("id", m.id);
    if (error) setStatus("Error: " + error.message);
    else { setStatus("Cancelled."); await reload(); }
  }

  if (profile && !canUse) {
    return <main className="stack"><h1 className="h1">Meetings</h1><div className="card">Not authorized.</div></main>;
  }

  const list = tab === "upcoming" ? upcoming : past;

  return (
    <main className="stack">
      {dialogModal}
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="h1">Meetings</h1>
          <div className="subtle">Online Chinese Classes &amp; Homework Club consultations.</div>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      {/* The standing Meet room per campus — this is what goes out in the
          confirmation email and the calendar invite. */}
      <div className="card">
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Meeting links</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          A permanent Google Meet room per campus. Create one at meet.google.com → New meeting →
          “Create a meeting for later”, then paste it here. Until it&apos;s set, parents are told
          the link will follow by email.
        </div>
        <div className="stack" style={{ gap: 10 }}>
          {types.map((t) => (
            <div key={t.id} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ minWidth: 150, fontWeight: 700, fontSize: 14 }}>{campusName(t.campus_id)}</div>
              <input
                className="input"
                style={{ flex: 1, minWidth: 240 }}
                placeholder="https://meet.google.com/abc-defg-hij"
                value={meetDraft[t.id] ?? ""}
                onChange={(e) => setMeetDraft((d) => ({ ...d, [t.id]: e.target.value }))}
              />
              <button className="btn" onClick={() => void saveMeetUrl(t.id)}>Save</button>
              <code style={{ fontSize: 12, color: "#6b7280" }}>/book/{t.slug}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 6, marginBottom: 14 }}>
          <button className={`btn${tab === "upcoming" ? " btn-primary" : ""}`} onClick={() => setTab("upcoming")}>
            Upcoming ({upcoming.length})
          </button>
          <button className={`btn${tab === "past" ? " btn-primary" : ""}`} onClick={() => setTab("past")}>
            Past ({past.length})
          </button>
          <button className={`btn${tab === "setup" ? " btn-primary" : ""}`} onClick={() => setTab("setup")}>
            Availability
          </button>
        </div>

        {tab === "setup" ? (
          <div className="stack" style={{ gap: 22 }}>
            {types.map((t) => (
              <TourAvailabilityEditor
                key={t.id}
                type={t}
                rows={avail.filter((a) => a.tour_type_id === t.id)}
                closed={blackouts.filter((b) => b.tour_type_id === t.id)}
                campusName={campusName(t.campus_id)}
                onAddWindow={addWindow}
                onRemoveWindow={removeWindow}
                onAddBlackout={addBlackout}
                onRemoveBlackout={removeBlackout}
              />
            ))}
          </div>
        ) : loading ? (
          <div className="subtle">Loading…</div>
        ) : list.length === 0 ? (
          <div className="subtle" style={{ padding: 20, textAlign: "center" }}>Nothing here yet.</div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {list.map((m) => {
              const t = typeOf(m.tour_type_id);
              const isOpen = open === m.id;
              return (
                <div key={m.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                  <div className="row-between" style={{ padding: "12px 14px", gap: 10, flexWrap: "wrap" }}>
                    <button
                      onClick={() => setOpen(isOpen ? null : m.id)}
                      style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", padding: 0, flex: 1, minWidth: 220 }}
                    >
                      <div style={{ fontWeight: 700 }}>
                        <span style={{ color: "#9ca3af", marginRight: 6 }}>{isOpen ? "▾" : "▸"}</span>
                        {m.parent_name}
                        {m.child_name ? <span className="subtle" style={{ fontWeight: 500 }}> · {m.child_name}</span> : null}
                      </div>
                      <div className="subtle" style={{ fontSize: 12 }}>
                        {fmt(m.starts_at, t?.time_zone ?? "America/Los_Angeles")} · {campusName(m.campus_id)}
                        {m.status === "cancelled" ? " · cancelled" : ""}
                      </div>
                    </button>
                    <div className="row" style={{ gap: 6, alignItems: "center" }}>
                      {t?.meet_url && m.status !== "cancelled" && (
                        <a className="btn" href={t.meet_url} target="_blank" rel="noopener noreferrer" style={mini}>Join</a>
                      )}
                      {m.status !== "cancelled" && (
                        <button className="btn" style={{ ...mini, color: "#991b1b" }} onClick={() => void cancelMeeting(m)}>Cancel</button>
                      )}
                    </div>
                  </div>

                  {isOpen && (
                    <div style={{ borderTop: "1px solid #f1f5f9", padding: "10px 14px", background: "#fafafa", display: "grid", gap: 6 }}>
                      <Row label="Email">{m.parent_email}</Row>
                      {m.parent_phone && <Row label="Phone">{m.parent_phone}</Row>}
                      {m.child_dob && <Row label="Child DOB">{m.child_dob}</Row>}
                      {ANSWER_LABELS.map(([key, label]) =>
                        m.answers?.[key] ? <Row key={key} label={label}>{m.answers[key]}</Row> : null
                      )}
                      {m.notes && <Row label="Notes">{m.notes}</Row>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: "flex-start", fontSize: 14 }}>
      <span style={{ minWidth: 170, color: "#6b7280", fontWeight: 700, fontSize: 12 }}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

const mini: React.CSSProperties = { padding: "4px 12px", fontSize: 12 };
