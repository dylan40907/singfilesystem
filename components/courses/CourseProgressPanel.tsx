"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { sendReminder } from "@/lib/courses";

type PickUser = { id: string; full_name: string | null; username: string | null; email: string | null; role: string | null };
type Item = { courseId: string; title: string; status: string };
type Row = { user: PickUser; items: Item[]; completed: number; total: number };

const nameOf = (u: { full_name: string | null; username: string | null; email: string | null }) =>
  (u.full_name ?? "").trim() || (u.username ?? "").trim() || u.email || "Unknown";

export default function CourseProgressPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    const [{ data: users }, { data: assigns }, { data: courses }] = await Promise.all([
      supabase.from("user_profiles").select("id, full_name, username, email, role").eq("is_active", true).order("full_name"),
      supabase.from("course_assignments").select("course_id, user_id, status"),
      supabase.from("courses").select("id, title, status"),
    ]);
    // Only count courses that are still active (not archived).
    const courseById = new Map(
      (courses ?? []).filter((c: any) => c.status !== "archived").map((c: any) => [c.id, c.title as string])
    );
    const byUser = new Map<string, Item[]>();
    (assigns ?? []).forEach((a: any) => {
      const title = courseById.get(a.course_id);
      if (!title) return;
      const arr = byUser.get(a.user_id) ?? [];
      arr.push({ courseId: a.course_id, title, status: a.status });
      byUser.set(a.user_id, arr);
    });
    const built: Row[] = (users ?? []).map((u: any) => {
      const items = (byUser.get(u.id) ?? []).sort((x, y) => x.title.localeCompare(y.title));
      return { user: u, items, completed: items.filter((i) => i.status === "completed").length, total: items.length };
    });
    setRows(built);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => nameOf(r.user).toLowerCase().includes(q));
  }, [rows, query]);

  async function remindUser(r: Row) {
    const incomplete = r.items.filter((i) => i.status !== "completed");
    if (incomplete.length === 0) return;
    setBusy(r.user.id);
    try {
      for (const i of incomplete) await sendReminder(i.courseId, [r.user.id]);
      setStatus(`🔔 Reminded ${nameOf(r.user)} about ${incomplete.length} course(s).`);
    } catch (e: any) {
      setStatus("Reminder error: " + (e?.message ?? "unknown"));
    } finally {
      setBusy(null);
    }
  }

  function toggle(id: string) {
    setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14, gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Employee progress</div>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          {status && <span className="badge badge-pink">{status}</span>}
          <input className="input" placeholder="Search employees…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 220 }} />
        </div>
      </div>

      {loading ? <div className="subtle">Loading…</div> : filtered.length === 0 ? (
        <div className="subtle" style={{ padding: 16 }}>No employees found.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {filtered.map((r) => {
            const remaining = r.total - r.completed;
            const open = expanded.has(r.user.id);
            return (
              <div key={r.user.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
                <div className="row-between" style={{ padding: "12px 14px", gap: 10, flexWrap: "wrap" }}>
                  <button onClick={() => r.total > 0 && toggle(r.user.id)}
                    style={{ background: "none", border: "none", textAlign: "left", cursor: r.total > 0 ? "pointer" : "default", padding: 0, flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 700 }}>{r.total > 0 && <span style={{ color: "#9ca3af", marginRight: 6 }}>{open ? "▾" : "▸"}</span>}{nameOf(r.user)}</div>
                    <div className="subtle" style={{ fontSize: 12 }}>{r.user.role}</div>
                  </button>
                  <div className="row" style={{ gap: 12, alignItems: "center" }}>
                    {r.total === 0 ? (
                      <span className="subtle" style={{ fontSize: 13 }}>No courses assigned</span>
                    ) : (
                      <>
                        <ProgressBadge completed={r.completed} total={r.total} />
                        {remaining > 0 && (
                          <button className="btn" style={{ padding: "4px 12px", fontSize: 13 }} disabled={busy === r.user.id} onClick={() => remindUser(r)}>
                            {busy === r.user.id ? "Reminding…" : `🔔 Remind (${remaining})`}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {open && r.total > 0 && (
                  <div style={{ borderTop: "1px solid #f1f5f9", padding: "8px 14px", display: "grid", gap: 6, background: "#fafafa" }}>
                    {r.items.map((i) => (
                      <div key={i.courseId} className="row-between" style={{ padding: "4px 0" }}>
                        <span>{i.title}</span>
                        <StatusPill status={i.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProgressBadge({ completed, total }: { completed: number; total: number }) {
  const pct = Math.round((completed / Math.max(1, total)) * 100);
  const color = completed === total ? "#16a34a" : completed === 0 ? "#dc2626" : "#d97706";
  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <div style={{ width: 90, height: 8, background: "#f1f5f9", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{completed}/{total}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    completed: { bg: "#dcfce7", fg: "#166534", label: "Completed" },
    in_progress: { bg: "#fef9c3", fg: "#854d0e", label: "In progress" },
    not_started: { bg: "#fee2e2", fg: "#991b1b", label: "Not started" },
  };
  const s = map[status] ?? map.not_started;
  return <span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 12, padding: "3px 10px", borderRadius: 999 }}>{s.label}</span>;
}
