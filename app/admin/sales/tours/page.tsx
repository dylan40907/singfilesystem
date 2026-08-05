"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import { fetchAssignableStaff } from "@/lib/sales";
import TourAvailabilityEditor from "@/components/sales/TourAvailabilityEditor";

/**
 * Sales → Tours. Bookings made through the public page, plus the settings that
 * decide when parents can book and who hears about it.
 */

type TourType = {
  id: string; campus_id: string | null; slug: string; name: string;
  location: string | null; duration_minutes: number; buffer_minutes: number;
  min_notice_hours: number; max_days_ahead: number; capacity_per_slot: number;
  time_zone: string; is_active: boolean; kind?: string;
};
type Availability = { id: string; tour_type_id: string; day_of_week: number; start_time: string; end_time: string };
/** A closed date — holidays, a week away. Beats deleting and re-adding hours. */
type Blackout = { id: string; tour_type_id: string; day: string; reason: string | null };
type Tour = {
  id: string; tour_type_id: string | null; lead_id: string | null;
  starts_at: string; status: string;
  parent_name: string; parent_email: string; parent_phone: string | null;
  child_name: string | null; program: string | null; notes: string | null;
  cancel_reason: string | null; cancelled_by: string | null;
};


export default function SalesToursPage() {
  const { profile, campuses } = useCampusFilter();
  const { confirm, modal: dialogModal } = useDialog();
  const canUse =
    !!profile?.is_active &&
    (profile.role === "admin" || profile.role === "campus_admin" || profile.role === "supervisor");

  const [tab, setTab] = useState<"upcoming" | "past" | "setup">("upcoming");
  const [types, setTypes] = useState<TourType[]>([]);
  const [avail, setAvail] = useState<Availability[]>([]);
  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [staff, setStaff] = useState<{ id: string; full_name: string | null; role: string }[]>([]);
  const [notify, setNotify] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a, b, n, s, bo] = await Promise.all([
        // Consultations live in Sales → Meetings; this tab is preschool tours.
        supabase.from("sales_tour_types").select("*").eq("kind", "preschool_tour").order("name"),
        supabase.from("sales_tour_availability").select("*"),
        supabase.from("sales_tours").select("*").order("starts_at", { ascending: true }),
        supabase.from("sales_tour_notify").select("user_id"),
        fetchAssignableStaff(),
        supabase.from("sales_tour_blackouts").select("*").order("day", { ascending: true }),
      ]);
      const tt = (t.data ?? []) as TourType[];
      const preschoolIds = new Set(tt.map((x) => x.id));
      setTypes(tt);
      setAvail((a.data ?? []) as Availability[]);
      setBlackouts((bo.data ?? []) as Blackout[]);
      // Consultations are shown in Meetings, so they must not pad these lists.
      setTours(((b.data ?? []) as Tour[]).filter((r) => r.tour_type_id && preschoolIds.has(r.tour_type_id)));
      setNotify(((n.data ?? []) as { user_id: string }[]).map((x) => x.user_id));
      setStaff(s);
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
    () => tours.filter((t) => ["requested", "scheduled", "confirmed"].includes(t.status) && new Date(t.starts_at).getTime() >= now)
      // Requests needing a decision float to the top of the list.
      .sort((a, b) => Number(b.status === "requested") - Number(a.status === "requested") || a.starts_at.localeCompare(b.starts_at)),
    [tours, now]
  );
  const past = useMemo(
    () => tours.filter((t) => !["requested", "scheduled", "confirmed"].includes(t.status) || new Date(t.starts_at).getTime() < now)
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at)),
    [tours, now]
  );

  const typeName = (id: string | null) => types.find((t) => t.id === id)?.name ?? "Tour";
  const tzOf = (id: string | null) => types.find((t) => t.id === id)?.time_zone ?? "America/Los_Angeles";
  const fmt = (iso: string, tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      .format(new Date(iso));

  async function setTourStatus(t: Tour, next: string) {
    if (next === "cancelled") {
      const ok = await confirm(
        `Cancel ${t.parent_name}'s tour?\n\nThey are emailed automatically.`,
        { title: "Cancel tour", confirmLabel: "Cancel tour", danger: true }
      );
      if (!ok) return;
    }
    const patch: Record<string, unknown> = { status: next };
    if (next === "cancelled") {
      patch.cancelled_at = new Date().toISOString();
      patch.cancelled_by = "staff";
    }
    const { error } = await supabase.from("sales_tours").update(patch).eq("id", t.id);
    if (error) setStatus("Error: " + error.message);
    else { setStatus("✅ Updated."); await reload(); }
  }

  /**
   * Approve or deny a request. This goes through the edge function rather than
   * a direct update because it also emails the family and re-checks that this
   * tour is at a campus you're allowed to act on.
   */
  async function decide(t: Tour, action: "confirm" | "request_reschedule") {
    if (action === "request_reschedule") {
      const ok = await confirm(
        `Ask ${t.parent_name} to reschedule?\n\nTheir slot is released and they're emailed a link to pick again, ` +
        `along with our phone number.`,
        { title: "Ask to reschedule", confirmLabel: "Ask to reschedule", danger: true }
      );
      if (!ok) return;
    }
    setStatus(action === "confirm" ? "Confirming…" : "Sending…");
    try {
      const { data: sess } = await supabase.auth.getSession();
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tours-public`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sess.session?.access_token ?? ""}`,
        },
        body: JSON.stringify({
          mode: action,
          tour_id: t.id,
          slug: types.find((x) => x.id === t.tour_type_id)?.slug ?? "",
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out?.error ?? `Failed (${res.status})`);
      setStatus(action === "confirm" ? "✅ Confirmed — the family has been emailed." : "✅ Reschedule request sent.");
      await reload();
    } catch (e) {
      setStatus("Error: " + ((e as Error)?.message ?? "unknown"));
    }
  }

  async function toggleNotify(userId: string, on: boolean) {
    const { error } = on
      ? await supabase.from("sales_tour_notify").insert({ user_id: userId })
      : await supabase.from("sales_tour_notify").delete().eq("user_id", userId);
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  /**
   * Close a date, or a run of dates. Stored one row per day so a single day can
   * later be reopened without unpicking the whole week.
   */
  async function addBlackout(typeId: string, from: string, to: string, reason: string) {
    const days: string[] = [];
    const cur = new Date(`${from}T00:00:00`);
    const last = new Date(`${(to || from)}T00:00:00`);
    for (let guard = 0; guard < 400 && cur <= last; guard++) {
      // Format from the local parts, not toISOString — that converts to UTC and
      // would shift the date by a day depending on the offset.
      days.push(
        `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`
      );
      cur.setDate(cur.getDate() + 1);
    }
    // Skip days already closed, so re-submitting an overlapping range is safe.
    const already = new Set(blackouts.filter((b) => b.tour_type_id === typeId).map((b) => b.day));
    const rows = days.filter((d) => !already.has(d))
      .map((d) => ({ tour_type_id: typeId, day: d, reason: reason.trim() || null }));
    if (rows.length === 0) { setStatus("Those dates are already closed."); return; }
    const { error } = await supabase.from("sales_tour_blackouts").insert(rows);
    if (error) setStatus("Error: " + error.message);
    else { setStatus(`✅ Closed ${rows.length} day(s).`); await reload(); }
  }

  async function removeBlackout(id: string) {
    const { error } = await supabase.from("sales_tour_blackouts").delete().eq("id", id);
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  async function addWindow(typeId: string, day: number, start: string, end: string) {
    const { error } = await supabase
      .from("sales_tour_availability")
      .insert({ tour_type_id: typeId, day_of_week: day, start_time: start, end_time: end });
    if (error) setStatus("Error: " + error.message);
    else await reload();
  }

  if (profile && !canUse) {
    return <main className="stack"><h1 className="h1">Tours</h1><div className="card">Not authorized.</div></main>;
  }

  return (
    <main className="stack">
      {dialogModal}
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="h1">Tours</h1>
          <div className="subtle">Bookings from the website, and the hours parents can choose from.</div>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      <div className="card">
        <div className="row" style={{ gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          <button className={`btn${tab === "upcoming" ? " btn-primary" : ""}`} onClick={() => setTab("upcoming")}>
            Upcoming ({upcoming.length})
          </button>
          <button className={`btn${tab === "past" ? " btn-primary" : ""}`} onClick={() => setTab("past")}>
            Past &amp; cancelled ({past.length})
          </button>
          <button className={`btn${tab === "setup" ? " btn-primary" : ""}`} onClick={() => setTab("setup")}>
            Availability &amp; alerts
          </button>
        </div>

        {loading ? (
          <div className="subtle">Loading…</div>
        ) : tab === "setup" ? (
          <SetupPanel
            types={types} avail={avail} blackouts={blackouts} campuses={campuses}
            staff={staff} notify={notify}
            onAddWindow={addWindow}
            onRemoveWindow={async (id) => {
              const { error } = await supabase.from("sales_tour_availability").delete().eq("id", id);
              if (error) setStatus("Error: " + error.message); else await reload();
            }}
            onToggleNotify={toggleNotify}
            onAddBlackout={addBlackout}
            onRemoveBlackout={removeBlackout}
          />
        ) : (
          <TourTable
            rows={tab === "upcoming" ? upcoming : past}
            typeName={typeName} tzOf={tzOf} fmt={fmt}
            onStatus={setTourStatus}
            onDecide={decide}
            showActions={tab === "upcoming"}
          />
        )}
      </div>
    </main>
  );
}

function TourTable({
  rows, typeName, tzOf, fmt, onStatus, onDecide, showActions,
}: {
  rows: Tour[];
  typeName: (id: string | null) => string;
  tzOf: (id: string | null) => string;
  fmt: (iso: string, tz: string) => string;
  onStatus: (t: Tour, next: string) => void;
  onDecide: (t: Tour, action: "confirm" | "request_reschedule") => void;
  showActions: boolean;
}) {
  if (rows.length === 0) return <div className="subtle" style={{ padding: 20, textAlign: "center" }}>Nothing here yet.</div>;
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 760 }}>
        <thead>
          <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280" }}>
            <th style={th}>When</th><th style={th}>Family</th><th style={th}>Child</th>
            <th style={th}>Program</th><th style={th}>Tour</th><th style={th}>Status</th>
            {showActions && <th style={th}></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} style={{ borderTop: "1px solid #f1f5f9" }}>
              <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 700 }}>{fmt(t.starts_at, tzOf(t.tour_type_id))}</td>
              <td style={td}>
                {t.lead_id ? (
                  <Link href={`/admin/sales/${t.lead_id}`} style={{ fontWeight: 700, color: "#111827" }}>{t.parent_name}</Link>
                ) : <span style={{ fontWeight: 700 }}>{t.parent_name}</span>}
                <div className="subtle" style={{ fontSize: 12 }}>{t.parent_email}{t.parent_phone ? ` · ${t.parent_phone}` : ""}</div>
              </td>
              <td style={td}>{t.child_name || <span className="subtle">—</span>}</td>
              <td style={td}>{t.program || <span className="subtle">—</span>}</td>
              <td style={td}>{typeName(t.tour_type_id)}</td>
              <td style={td}>
                <StatusPill status={t.status} />
                {t.cancelled_by && <div className="subtle" style={{ fontSize: 11 }}>by {t.cancelled_by}</div>}
              </td>
              {showActions && (
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                  {t.status === "requested" ? (
                    /* Nothing has been promised to the family yet — the only
                       two moves are to approve the time or ask for another. */
                    <>
                      <button className="btn btn-primary" style={mini} onClick={() => onDecide(t, "confirm")}>✓ Confirm</button>
                      <button className="btn" style={{ ...mini, color: "#9a3412" }} onClick={() => onDecide(t, "request_reschedule")}>Ask to reschedule</button>
                    </>
                  ) : (
                    <>
                      <button className="btn" style={mini} onClick={() => onStatus(t, "completed")}>Attended</button>
                      <button className="btn" style={mini} onClick={() => onStatus(t, "no_show")}>No-show</button>
                      <button className="btn" style={{ ...mini, color: "#991b1b" }} onClick={() => onStatus(t, "cancelled")}>Cancel</button>
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SetupPanel({
  types, avail, blackouts, campuses, staff, notify, onAddWindow, onRemoveWindow, onToggleNotify,
  onAddBlackout, onRemoveBlackout,
}: {
  types: TourType[];
  avail: Availability[];
  blackouts: Blackout[];
  campuses: { id: string; name: string }[];
  staff: { id: string; full_name: string | null; role: string }[];
  notify: string[];
  onAddWindow: (typeId: string, day: number, start: string, end: string) => void;
  onRemoveWindow: (id: string) => void;
  onToggleNotify: (userId: string, on: boolean) => void;
  onAddBlackout: (typeId: string, from: string, to: string, reason: string) => void;
  onRemoveBlackout: (id: string) => void;
}) {
  return (
    <div className="stack" style={{ gap: 22 }}>
      {types.map((t) => (
        <TourAvailabilityEditor
          key={t.id}
          type={t}
          rows={avail.filter((a) => a.tour_type_id === t.id)}
          closed={blackouts.filter((b) => b.tour_type_id === t.id)}
          campusName={campuses.find((c) => c.id === t.campus_id)?.name ?? "No campus"}
          onAddWindow={onAddWindow}
          onRemoveWindow={onRemoveWindow}
          onAddBlackout={onAddBlackout}
          onRemoveBlackout={onRemoveBlackout}
        />
      ))}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>Who gets told about bookings</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          These people get a notification in the portal, a push on the HR app and an email whenever a tour is
          booked, moved or cancelled.
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {staff.map((s) => (
            <label key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input
                type="checkbox"
                checked={notify.includes(s.id)}
                onChange={(e) => onToggleNotify(s.id, e.target.checked)}
              />
              {s.full_name ?? s.id} <span className="subtle" style={{ fontSize: 12 }}>({s.role})</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A request awaiting a decision should be impossible to miss in the list. */
function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    requested: { bg: "#fff7ed", fg: "#9a3412", label: "⏳ Needs confirming" },
    confirmed: { bg: "#dcfce7", fg: "#166534", label: "Confirmed" },
    scheduled: { bg: "#dcfce7", fg: "#166534", label: "Scheduled" },
    reschedule_requested: { bg: "#fef2f2", fg: "#991b1b", label: "Asked to reschedule" },
    cancelled: { bg: "#f3f4f6", fg: "#6b7280", label: "Cancelled" },
    completed: { bg: "#eff6ff", fg: "#1e40af", label: "Attended" },
    no_show: { bg: "#f3f4f6", fg: "#6b7280", label: "No-show" },
  };
  const s = map[status] ?? { bg: "#f3f4f6", fg: "#374151", label: status };
  return (
    <span style={{ background: s.bg, color: s.fg, fontWeight: 800, fontSize: 11, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

const th: React.CSSProperties = { padding: "10px 14px", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "10px 14px", color: "#374151", verticalAlign: "top" };
const mini: React.CSSProperties = { padding: "3px 9px", fontSize: 11, marginLeft: 5 };
