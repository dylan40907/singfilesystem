"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

const PINK = "#e6178d";

type Doc = { id: string; page_key: string; title: string; content: string; updated_at: string };

export default function LegalContentPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    supabase
      .from("learning_legal_documents")
      .select("*")
      .order("page_key")
      .then(({ data }) => {
        const list = (data ?? []) as Doc[];
        setDocs(list);
        const initEdits: Record<string, string> = {};
        list.forEach(d => { initEdits[d.id] = d.content; });
        setEdits(initEdits);
        setLoading(false);
      });
  }, []);

  async function save(doc: Doc) {
    setSaving(p => ({ ...p, [doc.id]: true }));
    setError("");
    const { error: e } = await supabase
      .from("learning_legal_documents")
      .update({ content: edits[doc.id] ?? "", updated_at: new Date().toISOString() })
      .eq("id", doc.id);
    if (e) {
      setError(e.message);
    } else {
      setSaved(p => ({ ...p, [doc.id]: true }));
      setTimeout(() => setSaved(p => ({ ...p, [doc.id]: false })), 2000);
    }
    setSaving(p => ({ ...p, [doc.id]: false }));
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ marginBottom: 24, fontSize: 14 }}>
        <Link href="/admin/learning" style={{ color: PINK, textDecoration: "none", fontWeight: 600 }}>← App Content</Link>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 8px" }}>Legal Content</h1>
      <p className="subtle" style={{ marginBottom: 32, fontSize: 14 }}>
        Edit the Terms of Use and Privacy Policy shown to users during sign-up.
      </p>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: "#dc2626", marginBottom: 20, fontSize: 14 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        {docs.map(doc => (
          <section
            key={doc.id}
            style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", padding: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{doc.title}</h2>
                <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
                  Last updated: {new Date(doc.updated_at).toLocaleString()}
                </div>
              </div>
              <button
                className="btn btn-primary"
                onClick={() => save(doc)}
                disabled={saving[doc.id]}
                style={{ minWidth: 80 }}
              >
                {saving[doc.id] ? "Saving…" : saved[doc.id] ? "✓ Saved" : "Save"}
              </button>
            </div>

            <textarea
              value={edits[doc.id] ?? ""}
              onChange={e => setEdits(p => ({ ...p, [doc.id]: e.target.value }))}
              rows={20}
              style={{
                width: "100%",
                border: "1px solid #d1d5db",
                borderRadius: 10,
                padding: "12px 14px",
                fontSize: 13,
                lineHeight: 1.6,
                fontFamily: "inherit",
                resize: "vertical",
                boxSizing: "border-box",
                color: "#222",
              }}
              placeholder={`Enter ${doc.title} text here…`}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
