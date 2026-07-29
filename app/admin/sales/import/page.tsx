"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useCampusFilter } from "@/lib/CampusContext";
import { useDialog } from "@/components/ui/useDialog";
import { fetchSources } from "@/lib/sales";
import {
  ParseResult,
  ParsedLead,
  SheetRows,
  normalizeSourceName,
  parseInquiryLog,
} from "@/lib/salesImport";

/**
 * One-time (repeatable) import of the legacy "Inquiry Log" workbook.
 *
 * Everything is parsed and shown BEFORE anything is written — the sheets are
 * inconsistent enough (three documented column layouts plus rows pasted between
 * them) that a blind import would quietly scramble fields. Rows the parser was
 * unsure about are listed as warnings so they can be checked by eye.
 */
export default function SalesImportPage() {
  const router = useRouter();
  const { confirm, modal: dialogModal } = useDialog();
  const { profile, campuses } = useCampusFilter();
  const isTrueAdmin = profile?.role === "admin";

  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<{ leads: number; children: number; activities: number } | null>(null);

  const onFile = useCallback(async (file: File) => {
    setBusy(true);
    setStatus("Reading workbook…");
    setParsed(null);
    setDone(null);
    try {
      // Loaded on demand: ExcelJS is large and only this page needs it.
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());

      const txt = (v: unknown): string => {
        if (v === null || v === undefined) return "";
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === "object") {
          const o = v as Record<string, unknown>;
          if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
          if (typeof o.text === "string") return o.text;
          if (typeof o.hyperlink === "string") return o.hyperlink.replace(/^mailto:/, "");
          if (o.result !== undefined) return String(o.result);
          return "";
        }
        return String(v);
      };

      const sheets: SheetRows[] = wb.worksheets.map((ws) => {
        const rows: string[][] = [];
        const width = Math.max(ws.columnCount, 30);
        for (let r = 1; r <= ws.rowCount; r++) {
          const cells: string[] = [];
          for (let c = 0; c <= width; c++) {
            cells[c] = c === 0 ? "" : txt(ws.getRow(r).getCell(c).value).replace(/\s+/g, " ").trim();
          }
          rows.push(cells);
        }
        return { sheet: ws.name, rows };
      });

      setParsed(parseInquiryLog(sheets));
      setFileName(file.name);
      setStatus("");
    } catch (e) {
      setStatus("Could not read that file: " + ((e as Error)?.message ?? "unknown"));
    } finally {
      setBusy(false);
    }
  }, []);

  const stats = useMemo(() => {
    if (!parsed) return null;
    let children = 0, activities = 0, warnings = 0, noCampus = 0;
    const byStatus = { active: 0, inactive: 0, enrolled: 0 };
    for (const l of parsed.leads) {
      children += l.children.length;
      activities += l.activities.length;
      warnings += l.warnings.length;
      if (l.campusNames.length === 0) noCampus += 1;
      byStatus[l.status] += 1;
    }
    return { children, activities, warnings, noCampus, byStatus };
  }, [parsed]);

  async function runImport() {
    if (!parsed) return;
    const ok = await confirm(
      `Import ${parsed.leads.length} leads, ${stats?.children ?? 0} children and ${stats?.activities ?? 0} history entries?\n\n` +
        `Existing leads are not touched — running this twice would create duplicates.`,
      { title: "Import inquiry log", confirmLabel: "Import" }
    );
    if (!ok) return;

    setBusy(true);
    setProgress(0);
    setStatus("Importing…");
    try {
      const sources = await fetchSources();
      const sourceByName = new Map(sources.map((s) => [s.name, s.id]));
      const campusByName = new Map(campuses.map((c) => [c.name, c.id]));
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id ?? null;

      let leadCount = 0, childCount = 0, actCount = 0;

      for (let i = 0; i < parsed.leads.length; i++) {
        const l = parsed.leads[i];
        const canonicalSource = normalizeSourceName(l.sourceName);

        const { data: lead, error } = await supabase
          .from("sales_leads")
          .insert({
            campus_ids: l.campusNames.map((n) => campusByName.get(n)).filter(Boolean) as string[],
            status: l.status,
            parent_first_name: l.parent_first_name,
            parent_last_name: l.parent_last_name,
            phone: l.phone,
            email: l.email,
            source_id: canonicalSource ? sourceByName.get(canonicalSource) ?? null : null,
            source_other: canonicalSource === "Other" ? l.sourceName : null,
            // Undated history rows still need an inquiry date; the earliest
            // logged follow-up is the best evidence we have.
            inquiry_date:
              l.activities.map((a) => a.activity_date).filter(Boolean).sort()[0] ??
              new Date().toISOString().slice(0, 10),
            notes: l.notes,
            staff_name: l.staff_name,
            // Flags the row as historical, which keeps the Mailchimp trigger
            // from pushing years of old addresses into the newsletter audience.
            imported_at: new Date().toISOString(),
            converted_at: l.status === "enrolled" ? new Date().toISOString() : null,
            created_by: uid,
          })
          .select("id")
          .single();

        if (error) throw new Error(`Row ${l.rows.join(",")} (${l.parent_last_name}): ${error.message}`);
        leadCount += 1;

        if (l.children.length) {
          // The sheet's desired-start sat on the row, i.e. per child — which is
          // where it now lives, so it carries straight over.
          const { error: cErr } = await supabase.from("sales_lead_children").insert(
            l.children.map((c, idx) => ({
              lead_id: lead.id,
              ...c,
              desired_start_date: l.desired_start_date,
              desired_start_note: l.desired_start_note,
              order_index: idx,
            }))
          );
          if (cErr) throw new Error(`Children for ${l.parent_last_name}: ${cErr.message}`);
          childCount += l.children.length;
        }

        if (l.activities.length) {
          const { error: aErr } = await supabase.from("sales_activities").insert(
            l.activities.map((a) => ({
              lead_id: lead.id,
              kind: "imported" as const,
              note: a.note,
              activity_date: a.activity_date ?? new Date().toISOString().slice(0, 10),
              created_by: uid,
            }))
          );
          if (aErr) throw new Error(`History for ${l.parent_last_name}: ${aErr.message}`);
          actCount += l.activities.length;
        }

        setProgress(Math.round(((i + 1) / parsed.leads.length) * 100));
      }

      setDone({ leads: leadCount, children: childCount, activities: actCount });
      setStatus("");
    } catch (e) {
      setStatus("Import stopped: " + ((e as Error)?.message ?? "unknown") + " — leads imported before this point were kept.");
    } finally {
      setBusy(false);
    }
  }

  if (profile && !isTrueAdmin) {
    return (
      <main className="stack">
        <h1 className="h1">Import</h1>
        <div className="card">Only full admins can import the inquiry log.</div>
      </main>
    );
  }

  return (
    <main className="stack">
      {dialogModal}

      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Link href="/admin/sales" className="btn" style={{ padding: "4px 10px" }}>← Leads</Link>
        <h1 className="h1" style={{ margin: 0 }}>Import inquiry log</h1>
      </div>

      <div className="card">
        <div style={{ fontWeight: 800, marginBottom: 6 }}>1 · Choose the workbook</div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          Pick the <code>Inquiry Log.xlsx</code> export. Nothing is saved until you review the summary and press Import.
        </div>
        <input
          type="file"
          accept=".xlsx"
          disabled={busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }}
        />
        {fileName && <div className="subtle" style={{ fontSize: 12, marginTop: 8 }}>Loaded: {fileName}</div>}
        {status && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 10 }}>{status}</div>}
      </div>

      {done && (
        <div className="card" style={{ borderColor: "#bbf7d0", background: "#f0fdf4" }}>
          <div style={{ fontWeight: 800, color: "#166534" }}>Import complete</div>
          <div className="subtle" style={{ marginTop: 6 }}>
            {done.leads} leads, {done.children} children and {done.activities} history entries added.
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => router.push("/admin/sales")}>
            Go to Leads
          </button>
        </div>
      )}

      {parsed && !done && (
        <>
          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 12 }}>2 · Review</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14 }}>
              <Stat label="Families" value={String(parsed.leads.length)} accent />
              <Stat label="Children" value={String(stats?.children ?? 0)} />
              <Stat label="History entries" value={String(stats?.activities ?? 0)} />
              <Stat label="Active" value={String(stats?.byStatus.active ?? 0)} />
              <Stat label="Enrolled" value={String(stats?.byStatus.enrolled ?? 0)} />
              <Stat label="Inactive" value={String(stats?.byStatus.inactive ?? 0)} />
            </div>

            <div className="subtle" style={{ fontSize: 12, marginTop: 14 }}>
              Sheet rows → families:{" "}
              {parsed.sheetSummary.map((s) => `${s.sheet} ${s.rows}→${s.leads}`).join(" · ")}
              {parsed.skipped > 0 && ` · ${parsed.skipped} nameless rows skipped`}
            </div>
            {(stats?.noCampus ?? 0) > 0 && (
              <div className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
                {stats?.noCampus} lead(s) have no campus (blank, or listed both) — they import unassigned and are
                visible to full admins only until someone sets a campus.
              </div>
            )}
          </div>

          {(stats?.warnings ?? 0) > 0 && (
            <div className="card" style={{ borderColor: "#fde68a", background: "#fffbeb" }}>
              <div style={{ fontWeight: 800, color: "#92400e", marginBottom: 8 }}>
                {stats?.warnings} thing(s) worth checking
              </div>
              <div className="subtle" style={{ fontSize: 12, marginBottom: 10 }}>
                These rows didn’t look quite right. They will still import — check them afterwards.
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#78350f" }}>
                {parsed.leads.flatMap((l) => l.warnings.map((w) => `${l.sheet}: ${w}`)).slice(0, 40).map((w, i) => (
                  <li key={i} style={{ marginBottom: 3 }}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Preview (first 15)</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 820 }}>
                <thead>
                  <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280" }}>
                    <th style={th}>Parent</th><th style={th}>Status</th><th style={th}>Campus</th>
                    <th style={th}>Contact</th><th style={th}>Children</th><th style={th}>Source</th><th style={th}>History</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.leads.slice(0, 15).map((l: ParsedLead, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #f1f5f9" }}>
                      <td style={td}>{`${l.parent_last_name}, ${l.parent_first_name}`.replace(/^,\s*/, "")}</td>
                      <td style={td}>{l.status}</td>
                      <td style={td}>{l.campusNames.join(" + ") || <span className="subtle">—</span>}</td>
                      <td style={td}>{l.phone || l.email || <span className="subtle">—</span>}</td>
                      <td style={td}>{l.children.map((c) => c.name || "(unnamed)").join(", ") || <span className="subtle">—</span>}</td>
                      <td style={td}>{normalizeSourceName(l.sourceName) ?? <span className="subtle">—</span>}</td>
                      <td style={td}>{l.activities.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div style={{ fontWeight: 800, marginBottom: 10 }}>3 · Import</div>
            {busy && progress > 0 && (
              <div style={{ height: 6, borderRadius: 999, background: "#f3f4f6", marginBottom: 12 }}>
                <div style={{ height: 6, borderRadius: 999, background: "#e6178d", width: `${progress}%`, transition: "width .2s" }} />
              </div>
            )}
            <button className="btn btn-primary" onClick={() => void runImport()} disabled={busy}>
              {busy ? `Importing… ${progress}%` : `Import ${parsed.leads.length} leads`}
            </button>
            <div className="subtle" style={{ fontSize: 12, marginTop: 8 }}>
              Running this again would create duplicates — import once.
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 900, fontSize: 24, color: accent ? "#e6178d" : "#111827" }}>{value}</div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 12px", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "8px 12px", color: "#374151" };
