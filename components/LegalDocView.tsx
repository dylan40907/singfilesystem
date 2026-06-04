"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// Public, standalone renderer for a legal document stored in
// learning_legal_documents (anon-readable). Editing the document in the admin
// "Legal Content" section updates this page automatically — same source the
// mobile app reads at sign-up.
export default function LegalDocView({ pageKey }: { pageKey: string }) {
  const [doc, setDoc] = useState<{ title: string; content: string; updated_at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    supabase
      .from("learning_legal_documents")
      .select("title, content, updated_at")
      .eq("page_key", pageKey)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDoc(data as { title: string; content: string; updated_at: string });
          document.title = `${(data as { title: string }).title} · Sing in Chinese`;
        } else {
          setNotFound(true);
        }
        setLoading(false);
      });
  }, [pageKey]);

  const wrap: React.CSSProperties = {
    maxWidth: 760,
    margin: "0 auto",
    padding: "40px 22px 96px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    color: "#1f2937",
    lineHeight: 1.7,
  };

  if (loading) return <main style={wrap}><div style={{ color: "#6b7280" }}>Loading…</div></main>;
  if (notFound || !doc) return <main style={wrap}><div style={{ color: "#6b7280" }}>This document isn’t available.</div></main>;

  return (
    <main style={wrap}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#e6178d", marginBottom: 28, letterSpacing: 0.2 }}>
        Sing in Chinese
      </div>
      <div style={{ whiteSpace: "pre-wrap", fontSize: 15.5 }}>{doc.content}</div>
    </main>
  );
}
