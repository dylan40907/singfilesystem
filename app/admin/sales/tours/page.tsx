"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import { fetchAssignableStaff } from "@/lib/sales";

/**
 * Sales → Tours. Bookings made through the public page, plus the settings that
 * decide when parents can book and who hears about it.
 */

type TourType = {
  id: string; campus_id: string | null; slug: string; name: string;
  location: string | null; duration_minutes: number; buffer_minutes: number;
  min_notice_hours: number; max_days_ahead: number; capacity_per_slot: number;
  time_zone: string; is_active: boolean;
};
type Availability = { id: string; tour_type_id: string; day_of_week: number; start_time: string; end_time: string };
type Tour = {
  id: string; tour_type_id: string | null; lead_id: string | null;
  starts_at: string; status: string;
  parent_name: string; parent_email: string; parent_phone: string | null;
  child_name: string | null; program: string | null; notes: string | null;
  cancel_reason: string | null; cancelled_by: string | null;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function SalesToursPage() {
  const { profile, campuses } = useCampusFilter();
  const { confirm, modal: dialogModal } = useDialog();
  const canUse =
    !!profile?.is_active &&
    (profile.role === "admin" || profile.role === "campus_admin" || profile.role === "supervisor");

  const [tab, setTab] = useState<"upcoming" | "past" | "setup">("upcoming");
  const [types, setTypes] = useState<TourType[]>([]);
  const [avail, setAvail] = useState<Availability[]>([]);
  const [tours, setTours] = useState<Tour[]>([]);
  const [staff, setStaff] = useState<{ id: string; full_name: string | null; role: string }[]>([]);
  const [notify, setNotify] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a, b, n, s] = await Promise.all([
        supabase.from("sales_tour_types").select("*").order("name"),
        supabase.from("sales_tour_availability").select("*"),
        supabase.from("sales_tours").select("*").order("starts_at", { ascending: true }),
        supabase.from("sales_tour_notify").select("user_id"),
        fetchAssignableStaff(),
      ]);
      setTypes((t.data ?? []) as TourType[]);
      setAvail((a.data ?? []) as Availability[]);
      setTours((b.data ?? []) as Tour[]);
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
    () => tours.filter((t) => t.status === "scheduled" && new Date(t.starts_at).getTime() >= now),
    [tours, now]
  );
  const past = useMemo(
    () => tours.filter((t) => t.status !== "scheduled" || new Date(t.starts_at).getTime() < now)
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

  async function toggleNotify(userId: string, on: boolean) {
    const { error } = on
      ? await supabase.from("sales_tour_notify").insert({ user_id: userId })
      : await supabase.from("sales_tour_notify").delete().eq("user_id", userId);
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
            types={types} avail={avail} campuses={campuses}
            staff={staff} notify={notify}
            onAddWindow={addWindow}
            onRemoveWindow={async (id) => {
              const { error } = await supabase.from("sales_tour_availability").delete().eq("id", id);
              if (error) setStatus("Error: " + error.message); else await reload();
            }}
            onToggleNotify={toggleNotify}
          />
        ) : (
          <TourTable
            rows={tab === "upcoming" ? upcoming : past}
            typeName={typeName} tzOf={tzOf} fmt={fmt}
            onStatus={setTourStatus}
            showActions={tab === "upcoming"}
          />
        )}
      </div>
    </main>
  );
}

function TourTable({
  rows, typeName, tzOf, fmt, onStatus, showActions,
}: {
  rows: Tour[];
  typeName: (id: string | null) => string;
  tzOf: (id: string | null) => string;
  fmt: (iso: string, tz: string) => string;
  onStatus: (t: Tour, next: string) => void;
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
                {t.status}
                {t.cancelled_by && <div className="subtle" style={{ fontSize: 11 }}>by {t.cancelled_by}</div>}
              </td>
              {showActions && (
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="btn" style={mini} onClick={() => onStatus(t, "completed")}>Attended</button>
                  <button className="btn" style={mini} onClick={() => onStatus(t, "no_show")}>No-show</button>
                  <button className="btn" style={{ ...mini, color: "#991b1b" }} onClick={() => onStatus(t, "cancelled")}>Cancel</button>
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
  types, avail, campuses, staff, notify, onAddWindow, onRemoveWindow, onToggleNotify,
}: {
  types: TourType[];
  avail: Availability[];
  campuses: { id: string; name: string }[];
  staff: { id: string; full_name: string | null; role: string }[];
  notify: string[];
  onAddWindow: (typeId: string, day: number, start: string, end: string) => void;
  onRemoveWindow: (id: string) => void;
  onToggleNotify: (userId: string, on: boolean) => void;
}) {
  const [day, setDay] = useState(3);
  const [from, setFrom] = useState("09:30");
  const [to, setTo] = useState("11:30");

  return (
    <div className="stack" style={{ gap: 22 }}>
      {types.map((t) => {
        const rows = avail.filter((a) => a.tour_type_id === t.id)
          .sort((a, b) => a.day_of_week - b.day_of_week || a.start_time.localeCompare(b.start_time));
        const campus = campuses.find((c) => c.id === t.campus_id)?.name ?? "No campus";
        return (
          <div key={t.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
            <div className="row-between" style={{ flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
              <div style={{ fontWeight: 800 }}>{t.name}</div>
              <code style={{ fontSize: 12, color: "#6b7280" }}>/book/{t.slug}</code>
            </div>
            <div className="subtle" style={{ fontSize: 12, marginBottom: 12 }}>
              {campus} · {t.duration_minutes} min · {t.min_notice_hours}h notice · up to {t.max_days_ahead} days ahead
            </div>

            {rows.length === 0 ? (
              <div className="subtle" style={{ fontSize: 13, marginBottom: 10 }}>
                No hours set yet — the booking page will show nothing until you add some.
              </div>
            ) : (
              <div className="stack" style={{ gap: 6, marginBottom: 10 }}>
                {rows.map((a) => (
                  <div key={a.id} className="row-between" style={{ gap: 8 }}>
                    <span style={{ fontSize: 14 }}>
                      <strong>{DAYS[a.day_of_week]}</strong> {String(a.start_time).slice(0, 5)}–{String(a.end_time).slice(0, 5)}
                    </span>
                    <button className="btn" style={{ ...mini, color: "#991b1b" }} onClick={() => onRemoveWindow(a.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select className="select" style={{ maxWidth: 150 }} value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
              <input className="input" style={{ maxWidth: 120 }} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
              <span className="subtle">to</span>
              <input className="input" style={{ maxWidth: 120 }} type="time" value={to} onChange={(e) => setTo(e.target.value)} />
              <button className="btn" onClick={() => onAddWindow(t.id, day, from, to)}>+ Add hours</button>
            </div>
          </div>
        );
      })}

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

const th: React.CSSProperties = { padding: "10px 14px", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "10px 14px", color: "#374151", verticalAlign: "top" };
const mini: React.CSSProperties = { padding: "3px 9px", fontSize: 11, marginLeft: 5 };
