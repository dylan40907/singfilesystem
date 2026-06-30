"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Row = {
  id: string;
  full_name: string | null;
  username: string | null;
  email: string | null;
  role: string;
  is_active: boolean;
  campus_id: string | null;
  last_sign_in_at: string | null;
  created_at: string | null;
};

const ROLE_LABEL: Record<string, string> = { admin: "Admin", campus_admin: "Campus Admin", supervisor: "Supervisor" };

function daysSince(iso: string | null): string {
  if (!iso) return "Never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  return `${d}d ago`;
}

/** Quarterly access review: everyone holding elevated access + last sign-in. */
export default function AccessReview({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("admin_access_review");
      if (error) setError(error.message);
      else setRows((data ?? []) as Row[]);
      setLoading(false);
    })();
  }, []);

  function exportCsv() {
    const head = ["Name", "Username", "Email", "Role", "Active", "Last sign-in", "Created"];
    const lines = rows.map((r) => [
      (r.full_name ?? "").replace(/,/g, " "), r.username ?? "", r.email ?? "",
      ROLE_LABEL[r.role] ?? r.role, r.is_active ? "yes" : "no",
      r.last_sign_in_at ?? "never", r.created_at ?? "",
    ].join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `access-review-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  return (
    <div onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div className="card" style={{ width: "100%", maxWidth: 820, maxHeight: "88vh", display: "flex", flexDirection: "column" }}>
        <div className="row-between" style={{ marginBottom: 6 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>🔐 Access review</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={exportCsv} disabled={rows.length === 0}>⬇ CSV</button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="subtle" style={{ fontSize: 13, marginBottom: 12 }}>
          Everyone with elevated access (Admin / Campus Admin / Supervisor) and when they last signed in. Review quarterly and remove anyone who no longer needs it.
        </div>

        <div style={{ overflow: "auto", flex: 1, border: "1px solid #e5e7eb", borderRadius: 12 }}>
          {loading ? <div className="subtle" style={{ padding: 20 }}>Loading…</div>
            : error ? <div style={{ padding: 20, color: "#991b1b" }}>{error}</div>
            : rows.length === 0 ? <div className="subtle" style={{ padding: 20 }}>No elevated accounts.</div>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f9fafb", textAlign: "left", color: "#6b7280", position: "sticky", top: 0 }}>
                    <th style={th}>Name</th><th style={th}>Role</th><th style={th}>Status</th><th style={th}>Last sign-in</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid #f1f5f9", opacity: r.is_active ? 1 : 0.5 }}>
                      <td style={td}>
                        <div style={{ fontWeight: 600 }}>{(r.full_name ?? r.username ?? r.email ?? "—").trim()}</div>
                        {r.username && <div className="subtle" style={{ fontSize: 11 }}>{r.username}</div>}
                      </td>
                      <td style={td}>
                        <span style={{ background: r.role === "admin" ? "#fee2e2" : "#dbeafe", color: r.role === "admin" ? "#991b1b" : "#1e40af", fontWeight: 700, fontSize: 11, padding: "2px 8px", borderRadius: 999 }}>
                          {ROLE_LABEL[r.role] ?? r.role}
                        </span>
                      </td>
                      <td style={td}>{r.is_active ? "Active" : "Inactive"}</td>
                      <td style={td}>{daysSince(r.last_sign_in_at)}{r.last_sign_in_at ? <span className="subtle" style={{ fontSize: 11 }}> · {new Date(r.last_sign_in_at).toLocaleDateString()}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "8px 12px", fontWeight: 700, fontSize: 11 };
const td: React.CSSProperties = { padding: "8px 12px", color: "#374151" };
