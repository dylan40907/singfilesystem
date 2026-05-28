"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Converter } from "opencc-js";
import { pinyin as getPinyin } from "pinyin-pro";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";

const PINK = "#e6178d";
const TEAL = "#4ECEC8";

type ZhLink = "trad_leads" | "simp_leads" | "unlinked";

let tradToSimp: ((t: string) => string) | null = null;
let simpToTrad: ((t: string) => string) | null = null;
try {
  tradToSimp = Converter({ from: "tw", to: "cn" });
  simpToTrad = Converter({ from: "cn", to: "tw" });
} catch {}

type Category = {
  id: string;
  name: string;
  name_zh_traditional: string | null;
  name_zh_simplified: string | null;
  pinyin: string | null;
  order_index: number;
};

type DictEntry = {
  id: string;                // slide id
  lesson_id: string;
  lesson_title: string;
  slide_number: number;
  term_chinese: string | null;
  term_chinese_simplified: string | null;
  pinyin: string | null;
  term_english: string | null;
};

type CategoryItem = {
  id: string;
  category_id: string;
  slide_id: string;
  order_index: number;
};

export default function DictionaryCategoriesPage() {
  const { confirm, modal } = useDialog();
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<CategoryItem[]>([]);
  const [allEntries, setAllEntries] = useState<DictEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New category form
  const [newName, setNewName] = useState("");
  const [newZhTrad, setNewZhTrad] = useState("");
  const [newZhSimp, setNewZhSimp] = useState("");
  const [newPinyin, setNewPinyin] = useState("");
  const [newZhLink, setNewZhLink] = useState<ZhLink>("trad_leads");
  const [pinyinManual, setPinyinManual] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [{ data: cats }, { data: catItems }, { data: entries }] = await Promise.all([
      supabase.from("learning_dictionary_categories").select("*").order("order_index"),
      supabase.from("learning_dictionary_category_items").select("*").order("order_index"),
      supabase.from("learning_dictionary").select("id, lesson_id, lesson_title, slide_number, term_chinese, term_chinese_simplified, pinyin, term_english"),
    ]);
    setCategories((cats ?? []) as Category[]);
    setItems((catItems ?? []) as CategoryItem[]);
    setAllEntries((entries ?? []) as DictEntry[]);
    setLoading(false);
  }

  // Auto-translate handlers for new-category form
  function handleNewZhTradChange(v: string) {
    if (newZhLink === "simp_leads") {
      setNewZhLink("unlinked");
      setNewZhTrad(v);
    } else if (newZhLink === "trad_leads") {
      setNewZhTrad(v);
      if (tradToSimp) setNewZhSimp(tradToSimp(v));
      if (!pinyinManual && v) setNewPinyin(getPinyin(v, { toneType: "symbol" }));
      else if (!pinyinManual && !v) setNewPinyin("");
    } else {
      setNewZhTrad(v);
    }
  }
  function handleNewZhSimpChange(v: string) {
    if (newZhLink === "trad_leads") {
      setNewZhLink("unlinked");
      setNewZhSimp(v);
    } else if (newZhLink === "simp_leads") {
      setNewZhSimp(v);
      if (simpToTrad) setNewZhTrad(simpToTrad(v));
      if (!pinyinManual && v) setNewPinyin(getPinyin(v, { toneType: "symbol" }));
      else if (!pinyinManual && !v) setNewPinyin("");
    } else {
      setNewZhSimp(v);
    }
  }
  function handleNewPinyinChange(v: string) {
    setPinyinManual(true);
    setNewPinyin(v);
  }

  async function addCategory() {
    if (!newName.trim()) return;
    setAdding(true);
    setError("");
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.order_index), -1);
    const { error: e } = await supabase.from("learning_dictionary_categories").insert({
      name: newName.trim(),
      name_zh_traditional: newZhTrad.trim() || null,
      name_zh_simplified: newZhSimp.trim() || null,
      pinyin: newPinyin.trim() || null,
      order_index: maxOrder + 1,
    });
    if (e) setError(e.message);
    else {
      setNewName(""); setNewZhTrad(""); setNewZhSimp(""); setNewPinyin("");
      setNewZhLink("trad_leads"); setPinyinManual(false);
      await load();
    }
    setAdding(false);
  }

  async function deleteCategory(id: string) {
    const cat = categories.find(c => c.id === id);
    const itemCount = items.filter(i => i.category_id === id).length;
    const ok = await confirm(
      `This will remove ${itemCount} term${itemCount === 1 ? "" : "s"} from this category. The original terms will remain in their lessons.`,
      { title: `Delete category "${cat?.name ?? ""}"?`, confirmLabel: "Delete", danger: true },
    );
    if (!ok) return;
    await supabase.from("learning_dictionary_categories").delete().eq("id", id);
    await load();
  }

  async function moveCategory(id: string, dir: -1 | 1) {
    const idx = categories.findIndex(c => c.id === id);
    if (idx === -1) return;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= categories.length) return;
    const a = categories[idx], b = categories[swapIdx];
    await Promise.all([
      supabase.from("learning_dictionary_categories").update({ order_index: b.order_index }).eq("id", a.id),
      supabase.from("learning_dictionary_categories").update({ order_index: a.order_index }).eq("id", b.id),
    ]);
    await load();
  }

  async function addTermToCategory(categoryId: string, slideId: string) {
    const existing = items.filter(i => i.category_id === categoryId);
    if (existing.some(i => i.slide_id === slideId)) return;
    const maxOrder = existing.reduce((m, i) => Math.max(m, i.order_index), -1);
    await supabase.from("learning_dictionary_category_items").insert({
      category_id: categoryId,
      slide_id: slideId,
      order_index: maxOrder + 1,
    });
    await load();
  }

  async function removeTermFromCategory(itemId: string) {
    await supabase.from("learning_dictionary_category_items").delete().eq("id", itemId);
    await load();
  }

  async function moveTerm(categoryId: string, itemId: string, dir: -1 | 1) {
    const catItems = items.filter(i => i.category_id === categoryId).sort((a, b) => a.order_index - b.order_index);
    const idx = catItems.findIndex(i => i.id === itemId);
    if (idx === -1) return;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= catItems.length) return;
    const a = catItems[idx], b = catItems[swapIdx];
    await Promise.all([
      supabase.from("learning_dictionary_category_items").update({ order_index: b.order_index }).eq("id", a.id),
      supabase.from("learning_dictionary_category_items").update({ order_index: a.order_index }).eq("id", b.id),
    ]);
    await load();
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px" }}>
      {modal}
      <div style={{ marginBottom: 24, fontSize: 14 }}>
        <Link href="/admin/learning" style={{ color: PINK, textDecoration: "none", fontWeight: 600 }}>← App Content</Link>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 8px" }}>Dictionary Categories</h1>
      <div className="subtle" style={{ marginBottom: 28, fontSize: 14 }}>
        Build custom slideshows by grouping terms from any lesson. Categories appear as the default Dictionary view in the app.
      </div>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: "#dc2626", marginBottom: 20, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* ── Add Category ── */}
      <section style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", padding: 22, marginBottom: 32, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>+ New Category</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
            Name (English)
            <input value={newName} onChange={e => setNewName(e.target.value)} style={inputStyle} placeholder="e.g. Greetings" />
          </label>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
            Pinyin
            <input value={newPinyin} onChange={e => handleNewPinyinChange(e.target.value)} style={inputStyle} placeholder="dǎ zhāo hū" />
          </label>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
            Name (Traditional Chinese)
            <input value={newZhTrad} onChange={e => handleNewZhTradChange(e.target.value)} style={inputStyle} placeholder="例：打招呼" />
          </label>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
            Name (Simplified Chinese)
            <input value={newZhSimp} onChange={e => handleNewZhSimpChange(e.target.value)} style={inputStyle} placeholder="例：打招呼" />
          </label>
        </div>
        <button className="btn btn-primary" onClick={addCategory} disabled={adding || !newName.trim()} style={{ marginTop: 14 }}>
          {adding ? "Adding…" : "Add Category"}
        </button>
      </section>

      {/* ── Categories list ── */}
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Categories ({categories.length})</h2>
      {categories.length === 0 && (
        <div className="subtle" style={{ textAlign: "center", padding: 40, border: "2px dashed #e5e7eb", borderRadius: 16 }}>
          No categories yet.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {categories.map((cat, catIdx) => {
          const catItems = items.filter(i => i.category_id === cat.id).sort((a, b) => a.order_index - b.order_index);
          const expanded = expandedId === cat.id;
          return (
            <div key={cat.id} style={{ background: "#fff", borderRadius: 14, border: `1.5px solid ${expanded ? TEAL : "#e5e7eb"}`, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <button onClick={() => moveCategory(cat.id, -1)} disabled={catIdx === 0} style={iconBtnStyle}>▲</button>
                  <button onClick={() => moveCategory(cat.id, 1)} disabled={catIdx === categories.length - 1} style={iconBtnStyle}>▼</button>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{cat.name}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                    {[cat.name_zh_traditional, cat.name_zh_simplified].filter(Boolean).join(" / ")}
                    {cat.pinyin ? <span style={{ marginLeft: 8, fontStyle: "italic", color: TEAL }}>{cat.pinyin}</span> : null}
                  </div>
                </div>
                <span className="subtle" style={{ fontSize: 13 }}>{catItems.length} term{catItems.length === 1 ? "" : "s"}</span>
                <button
                  onClick={() => setExpandedId(expanded ? null : cat.id)}
                  style={{ fontSize: 13, fontWeight: 600, padding: "6px 12px", borderRadius: 8, border: `1.5px solid ${TEAL}`, color: TEAL, background: "#fff", cursor: "pointer" }}
                >
                  {expanded ? "Close" : "Manage Terms"}
                </button>
                <button onClick={() => deleteCategory(cat.id)} style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer" }}>
                  Delete
                </button>
              </div>

              {expanded && (
                <CategoryEditor
                  category={cat}
                  catItems={catItems}
                  allEntries={allEntries}
                  onAdd={(slideId) => addTermToCategory(cat.id, slideId)}
                  onRemove={removeTermFromCategory}
                  onMove={(itemId, dir) => moveTerm(cat.id, itemId, dir)}
                  onCategoryUpdated={load}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CategoryEditor({
  category, catItems, allEntries, onAdd, onRemove, onMove, onCategoryUpdated,
}: {
  category: Category;
  catItems: CategoryItem[];
  allEntries: DictEntry[];
  onAdd: (slideId: string) => Promise<void>;
  onRemove: (itemId: string) => Promise<void>;
  onMove: (itemId: string, dir: -1 | 1) => Promise<void>;
  onCategoryUpdated: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaName, setMetaName] = useState(category.name);
  const [metaZhTrad, setMetaZhTrad] = useState(category.name_zh_traditional ?? "");
  const [metaZhSimp, setMetaZhSimp] = useState(category.name_zh_simplified ?? "");
  const [metaPinyin, setMetaPinyin] = useState(category.pinyin ?? "");
  const [metaLink, setMetaLink] = useState<ZhLink>(
    category.name_zh_traditional && category.name_zh_simplified ? "unlinked"
      : category.name_zh_simplified ? "simp_leads" : "trad_leads"
  );
  const [metaPinyinManual, setMetaPinyinManual] = useState(!!category.pinyin);
  const [savingMeta, setSavingMeta] = useState(false);

  function handleMetaTradChange(v: string) {
    if (metaLink === "simp_leads") {
      setMetaLink("unlinked");
      setMetaZhTrad(v);
    } else if (metaLink === "trad_leads") {
      setMetaZhTrad(v);
      if (tradToSimp) setMetaZhSimp(tradToSimp(v));
      if (!metaPinyinManual) setMetaPinyin(v ? getPinyin(v, { toneType: "symbol" }) : "");
    } else {
      setMetaZhTrad(v);
    }
  }
  function handleMetaSimpChange(v: string) {
    if (metaLink === "trad_leads") {
      setMetaLink("unlinked");
      setMetaZhSimp(v);
    } else if (metaLink === "simp_leads") {
      setMetaZhSimp(v);
      if (simpToTrad) setMetaZhTrad(simpToTrad(v));
      if (!metaPinyinManual) setMetaPinyin(v ? getPinyin(v, { toneType: "symbol" }) : "");
    } else {
      setMetaZhSimp(v);
    }
  }

  async function saveMeta() {
    setSavingMeta(true);
    await supabase.from("learning_dictionary_categories").update({
      name: metaName.trim(),
      name_zh_traditional: metaZhTrad.trim() || null,
      name_zh_simplified: metaZhSimp.trim() || null,
      pinyin: metaPinyin.trim() || null,
    }).eq("id", category.id);
    setSavingMeta(false);
    setEditingMeta(false);
    await onCategoryUpdated();
  }

  const itemSlideIds = useMemo(() => new Set(catItems.map(i => i.slide_id)), [catItems]);
  const orderedItems = useMemo(() =>
    catItems.map(i => ({ item: i, entry: allEntries.find(e => e.id === i.slide_id) })).filter(x => x.entry),
  [catItems, allEntries]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return allEntries.filter(e =>
      !itemSlideIds.has(e.id) && (
        (e.term_chinese ?? "").toLowerCase().includes(q) ||
        (e.term_chinese_simplified ?? "").toLowerCase().includes(q) ||
        (e.pinyin ?? "").toLowerCase().includes(q) ||
        (e.term_english ?? "").toLowerCase().includes(q) ||
        (e.lesson_title ?? "").toLowerCase().includes(q)
      )
    ).slice(0, 30);
  }, [allEntries, search, itemSlideIds]);

  return (
    <div style={{ borderTop: "1px solid #e5e7eb", padding: 18 }}>
      {/* Edit metadata */}
      {!editingMeta ? (
        <button onClick={() => setEditingMeta(true)} style={{ fontSize: 12, fontWeight: 600, color: "#6b7280", background: "none", border: "1px solid #d1d5db", padding: "5px 12px", borderRadius: 8, cursor: "pointer", marginBottom: 14 }}>
          Edit Category Details
        </button>
      ) : (
        <div style={{ background: "#fafafa", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Name
              <input value={metaName} onChange={e => setMetaName(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Pinyin
              <input value={metaPinyin} onChange={e => { setMetaPinyinManual(true); setMetaPinyin(e.target.value); }} style={inputStyle} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Traditional
              <input value={metaZhTrad} onChange={e => handleMetaTradChange(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
              Simplified
              <input value={metaZhSimp} onChange={e => handleMetaSimpChange(e.target.value)} style={inputStyle} />
            </label>
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={saveMeta} disabled={savingMeta}>
              {savingMeta ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditingMeta(false)} style={{ fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Current items */}
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 8 }}>Slideshow Order ({orderedItems.length})</div>
      {orderedItems.length === 0 ? (
        <div className="subtle" style={{ fontSize: 13, padding: "8px 0", marginBottom: 14 }}>No terms in this category yet. Search below to add some.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 18 }}>
          {orderedItems.map(({ item, entry }, idx) => entry ? (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f9fafb", borderRadius: 8, padding: "8px 12px", border: "1px solid #e5e7eb" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <button onClick={() => onMove(item.id, -1)} disabled={idx === 0} style={iconBtnStyle}>▲</button>
                <button onClick={() => onMove(item.id, 1)} disabled={idx === orderedItems.length - 1} style={iconBtnStyle}>▼</button>
              </div>
              <span style={{ fontSize: 11, color: "#9ca3af", width: 22 }}>{idx + 1}.</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {entry.term_chinese ?? entry.term_chinese_simplified ?? "—"}
                  {entry.term_chinese_simplified && entry.term_chinese && entry.term_chinese !== entry.term_chinese_simplified && (
                    <span style={{ color: "#9ca3af", fontWeight: 400, marginLeft: 8 }}>/ {entry.term_chinese_simplified}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#6b7280" }}>
                  {entry.pinyin && <span style={{ fontStyle: "italic", color: TEAL }}>{entry.pinyin}</span>}
                  {entry.term_english && <span style={{ marginLeft: 8 }}>{entry.term_english}</span>}
                  <span style={{ marginLeft: 8, color: "#9ca3af" }}>· from {entry.lesson_title}</span>
                </div>
              </div>
              <Link
                href={`/admin/learning/lesson/${entry.lesson_id}`}
                style={{ fontSize: 11, fontWeight: 600, color: PINK, textDecoration: "none", padding: "4px 10px", borderRadius: 6, border: `1px solid ${PINK}` }}
              >
                Edit slide ↗
              </Link>
              <button onClick={() => onRemove(item.id)} style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer" }}>
                ✕
              </button>
            </div>
          ) : null)}
        </div>
      )}

      {/* Search and add */}
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 8 }}>Add Terms</div>
      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search terms across all lessons (chinese, pinyin, english, lesson)"
        style={inputStyle}
      />
      {search.trim() && (
        <div style={{ marginTop: 8, maxHeight: 360, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff" }}>
          {searchResults.length === 0 && (
            <div className="subtle" style={{ padding: 16, fontSize: 13 }}>No matching terms.</div>
          )}
          {searchResults.map(e => (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid #f3f4f6" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {e.term_chinese ?? e.term_chinese_simplified ?? "—"}
                  {e.term_chinese_simplified && e.term_chinese && e.term_chinese !== e.term_chinese_simplified && (
                    <span style={{ color: "#9ca3af", fontWeight: 400, marginLeft: 8 }}>/ {e.term_chinese_simplified}</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#6b7280" }}>
                  {e.pinyin && <span style={{ fontStyle: "italic", color: TEAL }}>{e.pinyin}</span>}
                  {e.term_english && <span style={{ marginLeft: 8 }}>{e.term_english}</span>}
                  <span style={{ marginLeft: 8, color: "#9ca3af" }}>· {e.lesson_title}</span>
                </div>
              </div>
              <button
                onClick={() => { onAdd(e.id); }}
                style={{ fontSize: 12, fontWeight: 600, color: PINK, background: "#fff", border: `1.5px solid ${PINK}`, padding: "4px 10px", borderRadius: 6, cursor: "pointer" }}
              >
                + Add
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 14,
  boxSizing: "border-box",
};

const iconBtnStyle: React.CSSProperties = {
  fontSize: 10,
  width: 22,
  height: 18,
  padding: 0,
  borderRadius: 4,
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#6b7280",
  cursor: "pointer",
};
