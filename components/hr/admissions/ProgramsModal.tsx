"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import { Program, fetchPrograms } from "@/lib/admissions";
import { Modal } from "@/components/hr/admissions/shared";

/**
 * Manage the per-campus list of programs shown in the waitlist/roster Program
 * column. Add, rename, reorder, delete.
 */
export default function ProgramsModal({
  campusId, onClose, onChanged,
}: {
  campusId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { confirm, modal: dialog } = useDialog();
  const [list, setList] = useState<Program[]>([]);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function refresh() {
    try { setList(await fetchPrograms(campusId)); await onChanged(); }
    catch (e: any) { setErr(e?.message ?? "Load error"); }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [campusId]);

  async function add() {
    const name = adding.trim();
    if (!name) return;
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_admissions_programs").insert({ campus_id: campusId, name, order_index: list.length });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setAdding("");
    await refresh();
  }

  async function rename(id: string, name: string) {
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_admissions_programs").update({ name }).eq("id", id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await refresh();
  }

  async function setSession(id: string, patch: { counts_am?: boolean; counts_pm?: boolean }) {
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_admissions_programs").update(patch).eq("id", id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await refresh();
  }

  async function remove(p: Program) {
    const ok = await confirm(
      `Delete “${p.name}”? Waitlist/roster entries using it will keep their other details but show no program.`,
      { title: "Delete program", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    setBusy(true); setErr("");
    const { error } = await supabase.from("hr_admissions_programs").delete().eq("id", p.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    await refresh();
  }

  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const a = list[idx], b = list[j];
    setBusy(true);
    await supabase.from("hr_admissions_programs").update({ order_index: b.order_index }).eq("id", a.id);
    await supabase.from("hr_admissions_programs").update({ order_index: a.order_index }).eq("id", b.id);
    setBusy(false);
    await refresh();
  }

  return (
    <Modal title="Programs" subtitle="Options for the Program column (this campus only)" onClose={onClose} width={520}>
      {dialog}
      <div className="stack" style={{ gap: 10 }}>
        <div className="subtle" style={{ fontSize: 12 }}>
          Tick <b>AM</b> and/or <b>PM</b> so the roster can split each room&apos;s counts by session. A full-day program ticks <b>both</b> (it counts toward the AM and PM totals).
        </div>
        {list.length === 0 && <div className="subtle">No programs yet — add one below.</div>}
        {list.map((p, i) => (
          <ProgramRow key={p.id} program={p} disabled={busy}
            onRename={(name) => rename(p.id, name)} onDelete={() => remove(p)}
            onSetSession={(patch) => setSession(p.id, patch)}
            onUp={() => move(i, -1)} onDown={() => move(i, 1)}
            isFirst={i === 0} isLast={i === list.length - 1} />
        ))}
        <div className="row" style={{ gap: 8, borderTop: "1px solid #f3f4f6", paddingTop: 12 }}>
          <input className="input" placeholder="New program name" value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={() => void add()} disabled={busy || !adding.trim()}>Add</button>
        </div>
        {err ? <div style={{ color: "#b91c1c", fontSize: 12, fontWeight: 600 }}>{err}</div> : null}
      </div>
    </Modal>
  );
}

function ProgramRow({
  program, disabled, onRename, onDelete, onSetSession, onUp, onDown, isFirst, isLast,
}: {
  program: Program;
  disabled: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSetSession: (patch: { counts_am?: boolean; counts_pm?: boolean }) => void;
  onUp: () => void;
  onDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [name, setName] = useState(program.name);
  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <div className="stack" style={{ gap: 0 }}>
        <button className="btn" style={{ padding: "0 6px", fontSize: 10, lineHeight: 1.4 }} disabled={disabled || isFirst} onClick={onUp} title="Move up">▲</button>
        <button className="btn" style={{ padding: "0 6px", fontSize: 10, lineHeight: 1.4 }} disabled={disabled || isLast} onClick={onDown} title="Move down">▼</button>
      </div>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name.trim() && name !== program.name) onRename(name.trim()); }}
        disabled={disabled} style={{ flex: 1 }} />
      <SessionToggle label="AM" on={program.counts_am} disabled={disabled} onClick={() => onSetSession({ counts_am: !program.counts_am })} />
      <SessionToggle label="PM" on={program.counts_pm} disabled={disabled} onClick={() => onSetSession({ counts_pm: !program.counts_pm })} />
      <button className="btn" style={{ color: "#b91c1c" }} disabled={disabled} onClick={onDelete}>Delete</button>
    </div>
  );
}

function SessionToggle({ label, on, disabled, onClick }: { label: string; on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={`Counts toward the ${label} total`}
      style={{
        padding: "5px 10px", borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: disabled ? "default" : "pointer",
        border: `1.5px solid ${on ? "rgba(230,23,141,0.5)" : "#e5e7eb"}`,
        background: on ? "#e6178d" : "white", color: on ? "white" : "#9ca3af",
      }}
    >
      {label}
    </button>
  );
}
