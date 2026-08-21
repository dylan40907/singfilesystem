"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import NewLeadModal from "@/components/sales/NewLeadModal";
import {
  FIRST_CONTACT_LABEL,
  SALES_STATUS_LABEL,
  SalesLeadFull,
  SalesSource,
  SalesStatus,
  fetchLeads,
  fetchSources,
  leadChildNames,
  leadName,
  leadPrograms,
  leadSortName,
  leadStartDate,
  ACTION_TYPE_LABEL,
  leadStartNote,
  lostToOtherCampus,
  nextActionState,
  sourceLabel,
  statusForCampus,
  todayLocal,
} from "@/lib/sales";

/**
 * Sales → Leads. The spreadsheet's four sheets (TPV-Active, NT-Active,
 * Inactive, Enrolled) collapse into three status tabs plus a campus filter.
 */

type SortKey = "name" | "program" | "start" | "next_action" | "city" | "source" | "first_contact";

const SORT_LABEL: Record<SortKey, string> = {
  name: "Parent name",
  program: "Program",
  start: "Start date",
  next_action: "Next action date",
  city: "City",
  source: "How they heard",
  first_contact: "Call or tour",
};

/**
 * Which sorts each tab offers. Straight from the spec's sort matrix — e.g.
 * Inactive leads have no meaningful program/start/next-action to order by.
 */
const SORTS_FOR_TAB: Record<SalesStatus, SortKey[]> = {
  active: ["name", "program", "start", "next_action", "city", "source", "first_contact"],
  inactive: ["name", "city", "source", "first_contact"],
  enrolled: ["name", "program", "city", "source", "first_contact"],
};

function StatusPill({ status }: { status: SalesStatus }) {
  const map: Record<SalesStatus, { bg: string; fg: string }> = {
    active: { bg: "#dbeafe", fg: "#1e40af" },
    inactive: { bg: "#f3f4f6", fg: "#6b7280" },
    enrolled: { bg: "#dcfce7", fg: "#166534" },
  };
  const s = map[status];
  return (
    <span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>
      {SALES_STATUS_LABEL[status]}
    </span>
  );
}

function NextActionCell({ lead }: { lead: SalesLeadFull }) {
  const state = nextActionState(lead);
  if (state === "none") return <span className="subtle">—</span>;
  // Upcoming actions are the signature pink and bold so the next thing to do
  // stands out at a glance. Overdue and due-today keep their own colours —
  // those are warnings, and making everything pink would bury them.
  const color = state === "overdue" ? "#b91c1c" : state === "today" ? "#b45309" : "#e6178d";
  const type = lead.next_action_type ? ACTION_TYPE_LABEL[lead.next_action_type] : null;
  const note = (lead.next_action_note ?? "").trim();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color, fontWeight: 800 }}>
        {/* What to do and when, together — the date alone didn't say which
            action was due. */}
        {type ? `${type} — ` : ""}{fmtDate(lead.next_action_date)}
        {state === "overdue" ? " ⚠" : state === "today" ? " •" : ""}
      </div>
      {note && (
        <div style={{ color, fontWeight: 700, fontSize: 12, marginTop: 2, opacity: 0.85 }}>
          {note}
        </div>
      )}
    </div>
  );
}

function fmtDate(d: string | null): string {
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  if (!y || !m || !day) return d;
  return `${m}/${day}/${y}`;
}

export default function SalesLeadsPage() {
  const router = useRouter();
  const { modal: dialogModal } = useDialog();
  const { loading: campusLoading, profile, campuses } = useCampusFilter();
  // Sales keeps its own campus filter rather than the shared HR one: that one
  // locks campus admins to their own campus, which is exactly the restriction
  // we don't want here.
  const [filter, setFilter] = useState<string>("all");

  // Prospective families aren't campus property, so everyone on the sales side
  // sees every lead regardless of campus.
  // Was a role list, so a role granted a Sales page got "Not authorized".
  // PageAccessGuard in app/admin/sales/layout.tsx decides access now.
  const canUse = !!profile?.is_active;

  const [leads, setLeads] = useState<SalesLeadFull[]>([]);
  const [sources, setSources] = useState<SalesSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");

  const [tab, setTab] = useState<SalesStatus>("active");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // RLS already limits campus admins; this narrows for the admin picker.
      const campusId = filter === "all" ? undefined : filter === "unassigned" ? null : filter;
      const [ls, ss] = await Promise.all([fetchLeads(campusId), fetchSources()]);
      setLeads(ls);
      setSources(ss);
      setStatus("");
    } catch (e) {
      setStatus("Load error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    if (canUse && !campusLoading) void reload();
  }, [canUse, campusLoading, reload]);

  // Keep the sort valid when switching tabs — Inactive has no "start date".
  useEffect(() => {
    if (!SORTS_FOR_TAB[tab].includes(sortKey)) setSortKey("name");
  }, [tab, sortKey]);

  const campusName = useCallback(
    (id: string | null) => campuses.find((c) => c.id === id)?.name ?? "—",
    [campuses]
  );

  /** "Torrance PV + North Torrance" for a family touring both. */
  const campusLabel = useCallback(
    (ids: string[]) => {
      if (!ids?.length) return "—";
      return ids.map((id) => campuses.find((c) => c.id === id)?.name ?? "?").join(" + ");
    },
    [campuses]
  );

  // Viewing a single campus? Then a family who chose the OTHER campus reads as
  // a loss here, not a win. Full admins on "All campuses" see the real status.
  const viewCampusId = filter !== "all" && filter !== "unassigned" ? filter : null;
  const statusOf = useCallback(
    (l: SalesLeadFull) => statusForCampus(l, viewCampusId),
    [viewCampusId]
  );

  const counts = useMemo(() => ({
    active: leads.filter((l) => statusOf(l) === "active").length,
    inactive: leads.filter((l) => statusOf(l) === "inactive").length,
    enrolled: leads.filter((l) => statusOf(l) === "enrolled").length,
  }), [leads, statusOf]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = leads.filter((l) => statusOf(l) === tab);

    if (q) {
      rows = rows.filter((l) => {
        const hay = [
          leadName(l),
          l.phone ?? "",
          l.email ?? "",
          l.city ?? "",
          l.notes ?? "",
          l.staff_name ?? "",
          sourceLabel(l),
          leadChildNames(l),
          leadPrograms(l),
          l.children.map((c) => `${c.schedule ?? ""} ${c.previous_school ?? ""} ${c.chinese_level ?? ""}`).join(" "),
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }

    const dir = sortAsc ? 1 : -1;
    // Blank values always sort last regardless of direction — an empty city
    // shouldn't win first place just because the sort was flipped.
    const cmpText = (a: string, b: string) => {
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b) * dir;
    };
    const cmpDate = (a: string | null, b: string | null) => {
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return (a < b ? -1 : a > b ? 1 : 0) * dir;
    };

    const sorted = [...rows];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "program": return cmpText(leadPrograms(a), leadPrograms(b)) || cmpText(leadSortName(a), leadSortName(b));
        case "start": return cmpDate(leadStartDate(a), leadStartDate(b)) || cmpText(leadSortName(a), leadSortName(b));
        case "next_action": return cmpDate(a.next_action_date, b.next_action_date) || cmpText(leadSortName(a), leadSortName(b));
        case "city": return cmpText((a.city ?? "").toLowerCase(), (b.city ?? "").toLowerCase()) || cmpText(leadSortName(a), leadSortName(b));
        case "source": return cmpText(sourceLabel(a).toLowerCase(), sourceLabel(b).toLowerCase()) || cmpText(leadSortName(a), leadSortName(b));
        case "first_contact": return cmpText(a.first_contact_type ?? "", b.first_contact_type ?? "") || cmpText(leadSortName(a), leadSortName(b));
        case "name":
        default: return cmpText(leadSortName(a), leadSortName(b));
      }
    });
    return sorted;
  }, [leads, tab, search, sortKey, sortAsc, statusOf]);

  const dueSoon = useMemo(() => {
    const today = todayLocal();
    const act = leads.filter((l) => statusOf(l) === "active" && l.next_action_date);
    return {
      overdue: act.filter((l) => (l.next_action_date as string) < today).length,
      today: act.filter((l) => l.next_action_date === today).length,
    };
  }, [leads, statusOf]);

  function exportCsv() {
    const cols = [
      "Status", "Campuses", "Enrolled at", "Parent last name", "Parent first name", "Phone", "Email", "City",
      "How they heard", "Referred by", "Call or tour", "Inquiry date", "Desired start", "Desired start (note)",
      "Next action date", "Next action type", "Next action note", "Owner", "Time zone",
      "Preferred language", "Children", "Programs", "Notes",
    ];
    const rows = visible.map((l) => [
      SALES_STATUS_LABEL[statusOf(l)],
      campusLabel(l.campus_ids),
      l.enrolled_campus_id ? campusName(l.enrolled_campus_id) : "",
      l.parent_last_name, l.parent_first_name, l.phone ?? "", l.email ?? "", l.city ?? "",
      sourceLabel(l), l.referred_by ?? "",
      l.first_contact_type ? FIRST_CONTACT_LABEL[l.first_contact_type] : "",
      l.inquiry_date, leadStartDate(l) ?? "", leadStartNote(l),
      l.next_action_date ?? "", l.next_action_type ?? "", l.next_action_note ?? "",
      l.staff_name ?? "", l.time_zone ?? "", l.preferred_language ?? "",
      leadChildNames(l), leadPrograms(l), l.notes ?? "",
    ]);

    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    // BOM so Excel opens the Chinese names/notes as UTF-8 instead of mojibake.
    const csv = "﻿" + [cols, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-leads-${tab}-${todayLocal()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (profile && !canUse) {
    return (
      <main className="stack">
        <h1 className="h1">Sales</h1>
        <div className="card">
          <div style={{ fontWeight: 800 }}>Not authorized</div>
          <div className="subtle" style={{ marginTop: 6 }}>Only admins and campus admins can use Sales.</div>
        </div>
      </main>
    );
  }

  const availableSorts = SORTS_FOR_TAB[tab];

  return (
    <main className="stack">
      {dialogModal}

      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="h1">Leads</h1>
          <div className="subtle">
            Inquiry log — {counts.active} active, {counts.enrolled} enrolled, {counts.inactive} inactive.
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {status ? <span className="badge badge-pink">{status}</span> : null}
          <button className="btn" onClick={exportCsv} disabled={visible.length === 0}>⬇ Export CSV</button>
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ New lead</button>
        </div>
      </div>

      {(dueSoon.overdue > 0 || dueSoon.today > 0) && (
        <div className="card" style={{ borderColor: "#fbcfe8", background: "#fdf2f8" }}>
          <div className="row" style={{ gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontWeight: 800, color: "#9d174d" }}>Follow-ups</span>
            {dueSoon.today > 0 && <span style={{ color: "#b45309", fontWeight: 700 }}>{dueSoon.today} due today</span>}
            {dueSoon.overdue > 0 && <span style={{ color: "#b91c1c", fontWeight: 700 }}>{dueSoon.overdue} overdue</span>}
            <button
              className="btn"
              onClick={() => { setTab("active"); setSortKey("next_action"); setSortAsc(true); }}
            >
              Show them
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row-between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {(["active", "enrolled", "inactive"] as SalesStatus[]).map((s) => (
              <button
                key={s}
                className={`btn${tab === s ? " btn-primary" : ""}`}
                onClick={() => setTab(s)}
              >
                {SALES_STATUS_LABEL[s]} ({counts[s]})
              </button>
            ))}
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              className="select"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ minWidth: 150 }}
            >
              <option value="all">All campuses</option>
              {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="unassigned">No campus</option>
            </select>
            <input
              className="input"
              placeholder="Search name, phone, email, city, notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 240 }}
            />
          </div>
        </div>

        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span className="subtle" style={{ fontSize: 12, fontWeight: 700 }}>Sort by</span>
          {availableSorts.map((k) => (
            <button
              key={k}
              className={`btn${sortKey === k ? " btn-primary" : ""}`}
              style={{ padding: "4px 10px", fontSize: 12 }}
              onClick={() => {
                if (sortKey === k) setSortAsc((v) => !v);
                else { setSortKey(k); setSortAsc(true); }
              }}
            >
              {SORT_LABEL[k]}{sortKey === k ? (sortAsc ? " ↑" : " ↓") : ""}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="subtle">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="subtle" style={{ padding: 24, textAlign: "center" }}>
            {search.trim()
              ? `No ${SALES_STATUS_LABEL[tab].toLowerCase()} leads match “${search.trim()}”.`
              : `No ${SALES_STATUS_LABEL[tab].toLowerCase()} leads yet.`}
          </div>
        ) : (
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 900 }}>
              <thead>
                <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280" }}>
                  <th style={th}>Parent</th>
                  <th style={th}>Children</th>
                  <th style={th}>Program</th>
                  {tab === "active" && <th style={th}>Start</th>}
                  {tab === "active" && <th style={th}>Next action</th>}
                  <th style={th}>City</th>
                  <th style={th}>How they heard</th>
                  <th style={th}>First contact</th>
                  <th style={th}>Campus</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr
                    key={l.id}
                    onClick={() => router.push(`/admin/sales/${l.id}`)}
                    style={{ borderTop: "1px solid #f1f5f9", cursor: "pointer" }}
                  >
                    <td style={td}>
                      <div style={{ fontWeight: 700, color: "#111827" }}>{leadName(l)}</div>
                      <div className="subtle" style={{ fontSize: 12 }}>{l.phone || l.email || ""}</div>
                    </td>
                    <td style={td}>{leadChildNames(l) || <span className="subtle">—</span>}</td>
                    <td style={td}>{leadPrograms(l) || <span className="subtle">—</span>}</td>
                    {tab === "active" && <td style={td}>{fmtDate(leadStartDate(l)) || leadStartNote(l) || <span className="subtle">—</span>}</td>}
                    {tab === "active" && <td style={td}><NextActionCell lead={l} /></td>}
                    <td style={td}>{l.city || <span className="subtle">—</span>}</td>
                    <td style={td}>
                      {sourceLabel(l) || <span className="subtle">—</span>}
                      {l.referred_by && <div className="subtle" style={{ fontSize: 12 }}>via {l.referred_by}</div>}
                    </td>
                    <td style={td}>{l.first_contact_type ? FIRST_CONTACT_LABEL[l.first_contact_type] : <span className="subtle">—</span>}</td>
                    <td style={td}>
                      {campusLabel(l.campus_ids)}
                      {l.campus_ids.length > 1 && (
                        <div style={{ fontSize: 11, fontWeight: 800, color: "#7c3aed" }}>Both</div>
                      )}
                    </td>
                    <td style={td}>
                      <StatusPill status={statusOf(l)} />
                      {lostToOtherCampus(l, viewCampusId) && (
                        <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>
                          Enrolled at {campusName(l.enrolled_campus_id)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {createOpen && (
        <NewLeadModal
          sources={sources}
          campuses={campuses}
          defaultCampusId={filter !== "all" && filter !== "unassigned" ? filter : null}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => router.push(`/admin/sales/${id}`)}
        />
      )}
    </main>
  );
}

const th: React.CSSProperties = { padding: "10px 14px", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "10px 14px", color: "#374151", verticalAlign: "top" };
