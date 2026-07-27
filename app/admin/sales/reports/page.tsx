"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useCampusFilter } from "@/lib/CampusContext";
import {
  ConversionRow,
  FIRST_CONTACT_LABEL,
  FirstContactType,
  SalesLeadFull,
  conversionBySource,
  fetchLeads,
  formatPct,
  statusForCampus,
  topProducer,
} from "@/lib/sales";

/**
 * Conversion reporting.
 *
 * Two different things get called "conversion rate", and the notes could mean
 * either, so both are shown side by side:
 *   • Conversion rate — of the DECIDED leads from a source, how many enrolled.
 *     Leads still being worked are excluded; they haven't failed yet, and
 *     counting them as misses would make every new inquiry dent the rate.
 *   • Share of leads — what portion of all inquiries came from that source.
 *     This is what the spreadsheet's "Sheet2" tally actually computed.
 */
export default function SalesReportsPage() {
  const { loading: campusLoading, profile, campuses, filter, setFilter, isTrueAdmin } = useCampusFilter();
  const canUse = !!profile?.is_active && (profile.role === "admin" || profile.role === "campus_admin");

  const [leads, setLeads] = useState<SalesLeadFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const campusId = filter === "all" ? undefined : filter === "unassigned" ? null : filter;
      setLeads(await fetchLeads(campusId));
      setError("");
    } catch (e) {
      setError("Load error: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { if (canUse && !campusLoading) void reload(); }, [canUse, campusLoading, reload]);

  // Range applies to when the inquiry came in, so a cohort keeps its rate even
  // as its leads convert later.
  const inRange = useMemo(
    () => leads.filter((l) => (!from || l.inquiry_date >= from) && (!to || l.inquiry_date <= to)),
    [leads, from, to]
  );

  // On a single campus, a family who chose the other campus is a loss here.
  const viewCampusId = filter !== "all" && filter !== "unassigned" ? filter : null;

  const { overall, bySource } = useMemo(
    () => conversionBySource(inRange, viewCampusId),
    [inRange, viewCampusId]
  );
  const best = useMemo(() => topProducer(bySource), [bySource]);

  const byContact = useMemo(() => {
    const map = new Map<string, ConversionRow>();
    for (const l of inRange) {
      const key = l.first_contact_type ?? "__none__";
      const label = l.first_contact_type ? FIRST_CONTACT_LABEL[l.first_contact_type as FirstContactType] : "Not recorded";
      const r = map.get(key) ?? { key, label, total: 0, enrolled: 0, inactive: 0, active: 0, rate: null };
      const st = statusForCampus(l, viewCampusId);
      r.total += 1;
      if (st === "enrolled") r.enrolled += 1;
      else if (st === "inactive") r.inactive += 1;
      else r.active += 1;
      map.set(key, r);
    }
    return [...map.values()]
      .map((r) => ({ ...r, rate: r.enrolled + r.inactive > 0 ? r.enrolled / (r.enrolled + r.inactive) : null }))
      .sort((a, b) => b.total - a.total);
  }, [inRange, viewCampusId]);

  const byCampus = useMemo(() => {
    const map = new Map<string, ConversionRow>();
    // A lead touring both campuses counts toward each — so these rows sum to
    // more than the overall total, which is the honest picture per campus.
    for (const l of inRange) {
      const ids = l.campus_ids?.length ? l.campus_ids : ["__none__"];
      for (const id of ids) {
        const label = campuses.find((c) => c.id === id)?.name ?? "No campus";
        const r = map.get(id) ?? { key: id, label, total: 0, enrolled: 0, inactive: 0, active: 0, rate: null };
        const st = statusForCampus(l, id === "__none__" ? null : id);
        r.total += 1;
        if (st === "enrolled") r.enrolled += 1;
        else if (st === "inactive") r.inactive += 1;
        else r.active += 1;
        map.set(id, r);
      }
    }
    return [...map.values()]
      .map((r) => ({ ...r, rate: r.enrolled + r.inactive > 0 ? r.enrolled / (r.enrolled + r.inactive) : null }))
      .sort((a, b) => b.total - a.total);
  }, [inRange, campuses]);

  function exportCsv() {
    const rows: string[][] = [["Breakdown", "Group", "Leads", "Enrolled", "Inactive", "Still active", "Conversion rate", "Share of leads"]];
    const push = (breakdown: string, list: ConversionRow[]) => {
      for (const r of list) {
        rows.push([
          breakdown, r.label, String(r.total), String(r.enrolled), String(r.inactive), String(r.active),
          formatPct(r.rate), overall.total ? `${Math.round((r.total / overall.total) * 1000) / 10}%` : "—",
        ]);
      }
    };
    rows.push(["Overall", "All leads", String(overall.total), String(overall.enrolled), String(overall.inactive), String(overall.active), formatPct(overall.rate), "100%"]);
    push("How they heard", bySource);
    push("First contact", byContact);
    push("Campus", byCampus);

    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sales-conversion-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (profile && !canUse) {
    return (
      <main className="stack">
        <h1 className="h1">Reports</h1>
        <div className="card">Only admins and campus admins can use Sales.</div>
      </main>
    );
  }

  return (
    <main className="stack">
      <div className="row-between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 className="h1">Reports</h1>
          <div className="subtle">Conversion measured against decided leads — enrolled ÷ (enrolled + inactive).</div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {error ? <span className="badge badge-pink">{error}</span> : null}
          <button className="btn" onClick={exportCsv} disabled={inRange.length === 0}>⬇ Export CSV</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          {isTrueAdmin && (
            <div>
              <label style={lbl}>Campus</label>
              <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">All campuses</option>
                {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="unassigned">No campus</option>
              </select>
            </div>
          )}
          <div>
            <label style={lbl}>Inquiries from</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label style={lbl}>to</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {(from || to) && <button className="btn" onClick={() => { setFrom(""); setTo(""); }}>Clear dates</button>}
        </div>
      </div>

      {loading ? (
        <div className="card"><div className="subtle">Loading…</div></div>
      ) : inRange.length === 0 ? (
        <div className="card"><div className="subtle">No leads in this range yet.</div></div>
      ) : (
        <>
          <div className="card">
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Overall</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
              <Stat label="Conversion rate" value={formatPct(overall.rate)} big accent />
              <Stat
                label="Top producer"
                value={best ? best.label : "—"}
                sub={best ? `${best.enrolled} enrolled · ${formatPct(best.rate)} conversion` : "no enrolments yet"}
                big
                accent
              />
              <Stat label="Total leads" value={String(overall.total)} />
              <Stat label="Enrolled" value={String(overall.enrolled)} />
              <Stat label="Inactive" value={String(overall.inactive)} />
              <Stat label="Still active" value={String(overall.active)} />
            </div>
            {overall.active > 0 && (
              <div className="subtle" style={{ fontSize: 12, marginTop: 12 }}>
                {overall.active} lead{overall.active === 1 ? " is" : "s are"} still being worked and {overall.active === 1 ? "is" : "are"} excluded from the rate.
              </div>
            )}
          </div>

          <Breakdown title="How they heard" rows={bySource} total={overall.total} />
          <Breakdown title="Call or scheduled tour" rows={byContact} total={overall.total} />
          {filter === "all" && <Breakdown title="Campus" rows={byCampus} total={overall.total} />}
        </>
      )}
    </main>
  );
}

function Breakdown({ title, rows, total }: { title: string; rows: ConversionRow[]; total: number }) {
  const best = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="card">
      <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12 }}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 620 }}>
          <thead>
            <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280" }}>
              <th style={th}>Group</th>
              <th style={th}>Leads</th>
              <th style={th}>Share</th>
              <th style={th}>Enrolled</th>
              <th style={th}>Inactive</th>
              <th style={th}>Active</th>
              <th style={th}>Conversion</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={{ borderTop: "1px solid #f1f5f9" }}>
                <td style={td}>
                  <div style={{ fontWeight: 700, color: "#111827" }}>{r.label}</div>
                  <div style={{ height: 4, borderRadius: 999, background: "#f3f4f6", marginTop: 5, maxWidth: 180 }}>
                    <div style={{ height: 4, borderRadius: 999, background: "#e6178d", width: `${(r.total / best) * 100}%` }} />
                  </div>
                </td>
                <td style={td}>{r.total}</td>
                <td style={td}>{total ? `${Math.round((r.total / total) * 1000) / 10}%` : "—"}</td>
                <td style={{ ...td, color: "#166534", fontWeight: 700 }}>{r.enrolled}</td>
                <td style={td}>{r.inactive}</td>
                <td style={td}>{r.active}</td>
                <td style={{ ...td, fontWeight: 800 }}>{formatPct(r.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, big, accent }: { label: string; value: string; sub?: string; big?: boolean; accent?: boolean }) {
  return (
    <div>
      <div style={lbl}>{label}</div>
      <div style={{ fontWeight: 900, fontSize: big ? 30 : 22, color: accent ? "#e6178d" : "#111827", lineHeight: 1.15 }}>{value}</div>
      {sub && <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const th: React.CSSProperties = { padding: "10px 14px", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "10px 14px", color: "#374151" };
const lbl: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#6b7280", margin: "0 0 6px" };
