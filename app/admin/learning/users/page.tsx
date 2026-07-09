"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";

const PINK = "#e6178d";

type AppUser = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  chinese_pref: string | null;
  access_status: string;
  approved_at: string | null;
  access_expires_at: string | null;
};

type WhitelistEntry = {
  email: string;
  added_at: string;
  notes: string | null;
  expires_at: string | null;
};

type DeletedUser = {
  id: string;
  user_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_self: boolean;
  deleted_by_label: string | null;
};

type StudentGroup = { id: string; name: string; created_at: string; member_count: number; lock_count: number };

type Category = { id: string; name: string; order_index: number };
type Lesson = {
  id: string;
  category_id: string | null;
  title: string;
  is_locked: boolean;
  is_published: boolean;
  order_index: number;
};

const UNLEVELED_ID = "__none__";

const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  approved:  { label: "Approved",   color: "#16a34a", bg: "#dcfce7" },
  pending:   { label: "Pending",    color: "#d97706", bg: "#fef3c7" },
  no_record: { label: "No Request", color: "#6b7280", bg: "#f3f4f6" },
  disabled:  { label: "Disabled",   color: "#dc2626", bg: "#fef2f2" },
};

export default function UsersPage() {
  const { confirm, modal } = useDialog();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [whitelist, setWhitelist] = useState<WhitelistEntry[]>([]);
  const [approvedEmails, setApprovedEmails] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [deletedUsers, setDeletedUsers] = useState<DeletedUser[]>([]);
  const [groups, setGroups] = useState<StudentGroup[]>([]);
  const [groupAssignments, setGroupAssignments] = useState<Record<string, string>>({}); // lower(email) -> group_id
  const [newGroupName, setNewGroupName] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [loading, setLoading] = useState(true);

  // Song-topic permissions modal. Edits either an EMAIL's locks (a user/whitelist
  // row — same data whichever you open) or a GROUP's locks. Both reuse one modal.
  const [permTarget, setPermTarget] = useState<{ kind: "email" | "group"; email: string; name: string; groupId?: string } | null>(null);
  const [permInitialLocked, setPermInitialLocked] = useState<Set<string>>(new Set());
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});
  const [newEmail, setNewEmail] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [addingEmail, setAddingEmail] = useState(false);
  const [error, setError] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [approvedPage, setApprovedPage] = useState(0);
  const [whitelistSearch, setWhitelistSearch] = useState("");
  const [whitelistPage, setWhitelistPage] = useState(0);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    const [{ data: uData }, { data: wData }, { data: aData }, { data: cData }, { data: lData }, { data: dData }, { data: gData }, { data: gaData }] = await Promise.all([
      supabase.rpc("admin_list_learning_users"),
      supabase.from("learning_email_whitelist").select("*").order("added_at", { ascending: false }),
      supabase.from("learning_approved_emails").select("email"),
      supabase.from("learning_categories").select("id, name, order_index").order("order_index"),
      supabase.from("learning_lessons").select("id, category_id, title, is_locked, is_published, order_index").order("order_index"),
      supabase.rpc("admin_list_deleted_users"),
      supabase.rpc("admin_list_student_groups"),
      supabase.rpc("admin_list_user_group_assignments"),
    ]);
    setUsers((uData ?? []) as AppUser[]);
    setWhitelist((wData ?? []) as WhitelistEntry[]);
    setApprovedEmails(((aData ?? []) as { email: string }[]).map(r => r.email.toLowerCase()));
    setCategories((cData ?? []) as Category[]);
    setLessons((lData ?? []) as Lesson[]);
    setDeletedUsers((dData ?? []) as DeletedUser[]);
    setGroups((gData ?? []) as StudentGroup[]);
    const amap: Record<string, string> = {};
    ((gaData ?? []) as { email: string; group_id: string | null }[]).forEach(r => { if (r.group_id) amap[r.email.toLowerCase()] = r.group_id; });
    setGroupAssignments(amap);
    setLoading(false);
  }

  function isWhitelisted(email: string) {
    const lower = email.toLowerCase();
    return whitelist.some(w => w.email === lower) || approvedEmails.includes(lower);
  }

  async function approveUser(user: AppUser) {
    // The approved row moves from the Pending section to the Approved section,
    // unmounting the button that had focus — which bounces the scroll to the
    // top. Capture the scroll position and restore it after the list updates.
    const scrollY = typeof window !== "undefined" ? window.scrollY : 0;
    setBusy(user.id, true);
    setError("");
    const { error: e } = await supabase.rpc("admin_set_learning_access", {
      target_user_id: user.id,
      new_status: "approved",
    });
    if (e) {
      setError(e.message);
    } else {
      setUsers(prev => prev.map(u =>
        u.id === user.id ? { ...u, access_status: "approved", approved_at: new Date().toISOString() } : u
      ));
    }
    setBusy(user.id, false);
    requestAnimationFrame(() => window.scrollTo({ top: scrollY }));
  }

  async function disableUser(user: AppUser) {
    const whitelisted = isWhitelisted(user.email);
    const msg = whitelisted
      ? `Disable access for ${user.email}?\n\nWarning: This email is on the whitelist. They will still be able to log in until removed from the whitelist.`
      : `Disable access for ${user.email}? They will be shown the pending screen on next login.`;
    const ok = await confirm(msg, { title: "Disable User", confirmLabel: "Disable", danger: true });
    if (!ok) return;

    setBusy(user.id, true);
    setError("");
    const { error: e } = await supabase.rpc("admin_set_learning_access", {
      target_user_id: user.id,
      new_status: "disabled",
    });
    if (e) {
      setError(e.message);
    } else {
      setUsers(prev => prev.map(u =>
        u.id === user.id ? { ...u, access_status: "disabled", approved_at: null } : u
      ));
    }
    setBusy(user.id, false);
  }

  async function removeAccess(user: AppUser) {
    const ok = await confirm(
      `Remove the access request for ${user.email}? Their status will be cleared but their account will remain.`,
      { title: "Remove Request", confirmLabel: "Remove", danger: true }
    );
    if (!ok) return;

    setBusy(user.id, true);
    setError("");
    const { error: e } = await supabase.rpc("admin_remove_learning_access", {
      target_user_id: user.id,
    });
    if (e) {
      setError(e.message);
    } else {
      setUsers(prev => prev.map(u =>
        u.id === user.id ? { ...u, access_status: "no_record", approved_at: null } : u
      ));
    }
    setBusy(user.id, false);
  }

  // Convert an LA-local-midnight UTC ISO string to a 'YYYY-MM-DD' input value.
  // The DB stores midnight America/Los_Angeles as a UTC timestamp; we reverse that to display the picked date.
  function expiryToInputDate(iso: string | null): string {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      // Get parts in LA timezone
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(d);
      const yyyy = parts.find(p => p.type === "year")?.value ?? "";
      const mm   = parts.find(p => p.type === "month")?.value ?? "";
      const dd   = parts.find(p => p.type === "day")?.value ?? "";
      return `${yyyy}-${mm}-${dd}`;
    } catch { return ""; }
  }

  // Expiry is keyed by EMAIL so the whitelist row and the account's access stay
  // in sync — set it in one place and both update. Updates local state for both
  // sections (no full reload / scroll jump).
  async function setExpiryForEmail(email: string, dateStr: string | null) {
    setError("");
    const { error: e } = await supabase.rpc("admin_set_learning_expiry_by_email", {
      p_email: email,
      p_expiry: dateStr || null,
    });
    if (e) { setError(e.message); return; }
    // Midnight LA on the picked day (matches the RPC's stored value).
    const iso = dateStr ? new Date(`${dateStr}T00:00:00-07:00`).toISOString() : null;
    const lower = email.toLowerCase();
    setUsers(prev => prev.map(u => u.email.toLowerCase() === lower ? { ...u, access_expires_at: iso } : u));
    setWhitelist(prev => prev.map(w => w.email.toLowerCase() === lower ? { ...w, expires_at: iso } : w));
  }

  function setExpiry(user: AppUser, dateStr: string | null) {
    return setExpiryForEmail(user.email, dateStr);
  }

  async function deleteUser(user: AppUser) {
    const whitelisted = isWhitelisted(user.email);
    const msg = whitelisted
      ? `Permanently delete ${user.email}?\n\nWarning: This email is on the whitelist. If deleted, they can re-register and immediately gain access again.`
      : `Permanently delete ${user.email}? This cannot be undone.`;
    const ok = await confirm(msg, { title: "Delete User", confirmLabel: "Delete", danger: true });
    if (!ok) return;

    setBusy(user.id, true);
    setError("");
    const { error: e } = await supabase.rpc("admin_delete_user", {
      target_user_id: user.id,
    });
    if (e) {
      setError(e.message);
    } else {
      setUsers(prev => prev.filter(u => u.id !== user.id));
    }
    setBusy(user.id, false);
  }

  function setBusy(id: string, val: boolean) {
    setActionBusy(p => ({ ...p, [id]: val }));
  }

  async function openPermissions(email: string, name: string) {
    setPermTarget({ kind: "email", email, name });
    setPermLoading(true);
    setError("");
    const { data, error: e } = await supabase.rpc("admin_list_email_lesson_locks", {
      p_email: email,
    });
    if (e) {
      setError(e.message);
      setPermTarget(null);
    } else {
      setPermInitialLocked(new Set(((data ?? []) as { lesson_id: string }[]).map(r => r.lesson_id)));
    }
    setPermLoading(false);
  }

  async function openGroupPermissions(group: StudentGroup) {
    setPermTarget({ kind: "group", email: "", name: group.name, groupId: group.id });
    setPermLoading(true);
    setError("");
    const { data, error: e } = await supabase.rpc("admin_list_group_lesson_locks", {
      p_group_id: group.id,
    });
    if (e) {
      setError(e.message);
      setPermTarget(null);
    } else {
      setPermInitialLocked(new Set(((data ?? []) as { lesson_id: string }[]).map(r => r.lesson_id)));
    }
    setPermLoading(false);
  }

  async function savePermissions(lockedIds: string[]) {
    if (!permTarget) return;
    setPermSaving(true);
    setError("");
    const { error: e } = permTarget.kind === "group"
      ? await supabase.rpc("admin_set_group_lesson_locks", { p_group_id: permTarget.groupId, locked_lesson_ids: lockedIds })
      : await supabase.rpc("admin_set_email_lesson_locks", { p_email: permTarget.email, locked_lesson_ids: lockedIds });
    if (e) setError(e.message);
    else { setPermTarget(null); await loadAll(); }
    setPermSaving(false);
  }

  async function createGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    setAddingGroup(true);
    setError("");
    const { error: e } = await supabase.rpc("admin_create_student_group", { p_name: name });
    if (e) setError(e.message);
    else { setNewGroupName(""); await loadAll(); }
    setAddingGroup(false);
  }

  async function deleteGroup(group: StudentGroup) {
    const ok = await confirm(
      `Delete the group "${group.name}"? Members will be unassigned but keep their current locks. This doesn't delete any accounts.`,
      { title: "Delete Group", confirmLabel: "Delete", danger: true },
    );
    if (!ok) return;
    setError("");
    const { error: e } = await supabase.rpc("admin_delete_student_group", { p_group_id: group.id });
    if (e) setError(e.message);
    await loadAll();
  }

  async function assignGroup(email: string, groupId: string | null) {
    setError("");
    const { error: e } = await supabase.rpc("admin_assign_user_group", { p_email: email, p_group_id: groupId });
    if (e) setError(e.message);
    await loadAll();
  }

  async function addToWhitelist() {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    setAddingEmail(true);
    setError("");
    const { data: { session } } = await supabase.auth.getSession();
    const { error: e } = await supabase.from("learning_email_whitelist").insert({
      email,
      notes: newNotes.trim() || null,
      added_by: session?.user.id,
    });
    if (e) {
      setError(e.message);
    } else {
      setNewEmail("");
      setNewNotes("");
      const match = users.find(u => u.email.toLowerCase() === email);
      if (match && match.access_status !== "approved") {
        await approveUser(match);
      }
      await loadAll();
    }
    setAddingEmail(false);
  }

  async function removeFromWhitelist(email: string) {
    const ok = await confirm(`Remove ${email} from the whitelist?`, {
      title: "Remove from Whitelist",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await supabase.from("learning_email_whitelist").delete().eq("email", email);
    setWhitelist(prev => prev.filter(w => w.email !== email));
  }

  const pending  = users.filter(u => u.access_status === "pending" || u.access_status === "no_record");
  const approvedAll = users.filter(u => u.access_status === "approved");
  const disabled = users.filter(u => u.access_status === "disabled");

  // The approved list gets long. Filter it by a search box and page it.
  const APPROVED_PAGE_SIZE = 25;
  const q = userSearch.trim().toLowerCase();
  const approvedFiltered = q
    ? approvedAll.filter(u =>
        u.email.toLowerCase().includes(q) ||
        [u.first_name, u.last_name].filter(Boolean).join(" ").toLowerCase().includes(q))
    : approvedAll;
  const approvedPageCount = Math.max(1, Math.ceil(approvedFiltered.length / APPROVED_PAGE_SIZE));
  const approvedPageSafe = Math.min(approvedPage, approvedPageCount - 1);
  const approved = approvedFiltered.slice(approvedPageSafe * APPROVED_PAGE_SIZE, (approvedPageSafe + 1) * APPROVED_PAGE_SIZE);

  // The whitelist also gets long — search + page it the same way.
  const WHITELIST_PAGE_SIZE = 25;
  const wq = whitelistSearch.trim().toLowerCase();
  const whitelistFiltered = wq
    ? whitelist.filter(w => w.email.toLowerCase().includes(wq) || (w.notes ?? "").toLowerCase().includes(wq))
    : whitelist;
  const whitelistPageCount = Math.max(1, Math.ceil(whitelistFiltered.length / WHITELIST_PAGE_SIZE));
  const whitelistPageSafe = Math.min(whitelistPage, whitelistPageCount - 1);
  const whitelistPaged = whitelistFiltered.slice(whitelistPageSafe * WHITELIST_PAGE_SIZE, (whitelistPageSafe + 1) * WHITELIST_PAGE_SIZE);

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 20px" }}>
      {modal}

      {permTarget && (
        <PermissionsModal
          email={permTarget.email}
          name={permTarget.name}
          categories={categories}
          lessons={lessons}
          initialLocked={permInitialLocked}
          loading={permLoading}
          saving={permSaving}
          onCancel={() => setPermTarget(null)}
          onSave={savePermissions}
        />
      )}

      <div style={{ marginBottom: 24, fontSize: 14 }}>
        <Link href="/admin/learning" style={{ color: PINK, textDecoration: "none", fontWeight: 600 }}>← App Content</Link>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 8px" }}>User Access</h1>
      <p className="subtle" style={{ marginBottom: 32, fontSize: 14 }}>
        Manage who can access the learning app.
      </p>

      {error && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: "#dc2626", marginBottom: 20, fontSize: 14 }}>
          {error}
        </div>
      )}

      {/* Email whitelist */}
      <section style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", padding: 24, marginBottom: 32, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>
          Email Whitelist{whitelist.length > 0 ? ` (${whitelist.length})` : ""}
        </h2>
        <p className="subtle" style={{ fontSize: 13, marginBottom: 16 }}>
          Emails added here are automatically approved on sign-up, or immediately if they already have an account.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <input
            type="email"
            value={newEmail}
            onChange={e => setNewEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addToWhitelist()}
            placeholder="user@example.com"
            style={{ flex: 1, minWidth: 200, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
          />
          <input
            value={newNotes}
            onChange={e => setNewNotes(e.target.value)}
            placeholder="Notes (optional)"
            style={{ flex: 1, minWidth: 140, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
          />
          <button className="btn btn-primary" onClick={addToWhitelist} disabled={addingEmail || !newEmail.trim()}>
            {addingEmail ? "Adding…" : "Add Email"}
          </button>
        </div>

        {whitelist.length > WHITELIST_PAGE_SIZE && (
          <input
            value={whitelistSearch}
            onChange={(e) => { setWhitelistSearch(e.target.value); setWhitelistPage(0); }}
            placeholder="Search whitelist by email or notes…"
            style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14, marginBottom: 12 }}
          />
        )}

        {whitelist.length === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No whitelisted emails yet.</div>
        ) : whitelistFiltered.length === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No whitelisted emails match &ldquo;{whitelistSearch}&rdquo;.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {whitelistPaged.map(entry => (
              <div key={entry.email} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f9fafb", borderRadius: 8, padding: "8px 12px", border: "1px solid #e5e7eb" }}>
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{entry.email}</span>
                {entry.notes && <span className="subtle" style={{ fontSize: 12 }}>{entry.notes}</span>}
                <span className="subtle" style={{ fontSize: 11 }}>{new Date(entry.added_at).toLocaleDateString()}</span>
                <ExpiryField initial={expiryToInputDate(entry.expires_at)} onCommit={(d) => setExpiryForEmail(entry.email, d)} />
                <GroupSelect groups={groups} value={groupAssignments[entry.email.toLowerCase()]} onChange={(gid) => assignGroup(entry.email, gid)} />
                <button
                  onClick={() => openPermissions(entry.email, "")}
                  title="Edit which song topics this email can view (applies now if they have an account, otherwise on sign-up)"
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${PINK}`, color: PINK, background: "#fff", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 600 }}
                >
                  🔒 Song Topics
                </button>
                <button
                  onClick={() => removeFromWhitelist(entry.email)}
                  style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer" }}
                >
                  Remove
                </button>
              </div>
            ))}
            {whitelistPageCount > 1 && (
              <div className="row-between" style={{ alignItems: "center", marginTop: 8 }}>
                <button className="btn" disabled={whitelistPageSafe === 0} onClick={() => setWhitelistPage(p => Math.max(0, p - 1))}>‹ Prev</button>
                <span className="subtle" style={{ fontSize: 13 }}>
                  Page {whitelistPageSafe + 1} of {whitelistPageCount} · {whitelistFiltered.length} email{whitelistFiltered.length === 1 ? "" : "s"}
                </span>
                <button className="btn" disabled={whitelistPageSafe >= whitelistPageCount - 1} onClick={() => setWhitelistPage(p => Math.min(whitelistPageCount - 1, p + 1))}>Next ›</button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Student groups */}
      <section style={{ background: "#fff", borderRadius: 16, border: "1px solid #e5e7eb", padding: 24, marginBottom: 32, boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Student Groups</h2>
        <p className="subtle" style={{ fontSize: 13, marginBottom: 16 }}>
          A group carries its own set of locked song topics. Assigning a user (or a whitelist email) to a group copies the group&apos;s locks onto that account. You can still override an individual afterward in their Song Topics editor.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <input
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && createGroup()}
            placeholder="New group name (e.g. Mrs. Lee's Class)"
            style={{ flex: 1, minWidth: 220, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
          />
          <button className="btn btn-primary" onClick={createGroup} disabled={addingGroup || !newGroupName.trim()}>
            {addingGroup ? "Creating…" : "+ Create Group"}
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No groups yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {groups.map(g => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f9fafb", borderRadius: 8, padding: "8px 12px", border: "1px solid #e5e7eb" }}>
                <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>{g.name}</span>
                <span className="subtle" style={{ fontSize: 12 }}>
                  {g.member_count} member{g.member_count === 1 ? "" : "s"} · {g.lock_count} locked
                </span>
                <button
                  onClick={() => openGroupPermissions(g)}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${PINK}`, color: PINK, background: "#fff", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 600 }}
                >
                  🔒 Song Topics
                </button>
                <button onClick={() => deleteGroup(g)} style={{ fontSize: 12, color: "#dc2626", background: "none", border: "none", cursor: "pointer" }}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pending */}
      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>
          Pending Approvals
          {pending.length > 0 && (
            <span style={{ fontSize: 13, fontWeight: 600, background: "#fef3c7", color: "#d97706", borderRadius: 20, padding: "2px 10px", marginLeft: 8 }}>
              {pending.length}
            </span>
          )}
        </h2>
        {pending.length === 0 ? (
          <div className="subtle" style={{ fontSize: 14, padding: "12px 0" }}>No pending users.</div>
        ) : (
          <UserList
            users={pending}
            isWhitelisted={isWhitelisted}
            onApprove={approveUser}
            onRemove={removeAccess}
            onDelete={deleteUser}
            onExpiry={setExpiry}
            expiryToInputDate={expiryToInputDate}
            busy={actionBusy}
            onPermissions={openPermissions}
            groups={groups}
            groupAssignments={groupAssignments}
            onAssignGroup={assignGroup}
          />
        )}
      </section>

      {/* Approved */}
      {approvedAll.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <div className="row-between" style={{ gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
            <h2 style={{ fontSize: 17, fontWeight: 700 }}>Approved ({approvedAll.length})</h2>
            <input
              value={userSearch}
              onChange={(e) => { setUserSearch(e.target.value); setApprovedPage(0); }}
              placeholder="Search approved by name or email…"
              style={{ minWidth: 240, border: "1px solid #d1d5db", borderRadius: 8, padding: "8px 12px", fontSize: 14 }}
            />
          </div>
          {approvedFiltered.length === 0 ? (
            <div className="subtle" style={{ fontSize: 14, padding: "12px 0" }}>No approved users match &ldquo;{userSearch}&rdquo;.</div>
          ) : (
            <>
              <UserList
                users={approved}
                isWhitelisted={isWhitelisted}
                onDisable={disableUser}
                onDelete={deleteUser}
                onExpiry={setExpiry}
                expiryToInputDate={expiryToInputDate}
                busy={actionBusy}
                onPermissions={openPermissions}
                groups={groups}
                groupAssignments={groupAssignments}
                onAssignGroup={assignGroup}
              />
              {approvedPageCount > 1 && (
                <div className="row-between" style={{ alignItems: "center", marginTop: 14 }}>
                  <button className="btn" disabled={approvedPageSafe === 0} onClick={() => setApprovedPage(p => Math.max(0, p - 1))}>‹ Prev</button>
                  <span className="subtle" style={{ fontSize: 13 }}>
                    Page {approvedPageSafe + 1} of {approvedPageCount} · {approvedFiltered.length} users
                  </span>
                  <button className="btn" disabled={approvedPageSafe >= approvedPageCount - 1} onClick={() => setApprovedPage(p => Math.min(approvedPageCount - 1, p + 1))}>Next ›</button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Disabled */}
      {disabled.length > 0 && (
        <section>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Disabled ({disabled.length})</h2>
          <UserList
            users={disabled}
            isWhitelisted={isWhitelisted}
            onApprove={approveUser}
            onDelete={deleteUser}
            onExpiry={setExpiry}
            expiryToInputDate={expiryToInputDate}
            busy={actionBusy}
            onPermissions={openPermissions}
            groups={groups}
            groupAssignments={groupAssignments}
            onAssignGroup={assignGroup}
          />
        </section>
      )}

      {/* Deleted users — audit record (kept after the account is gone) */}
      {deletedUsers.length > 0 && (
        <section style={{ marginTop: 8 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Deleted Users ({deletedUsers.length})</h2>
          <p className="subtle" style={{ fontSize: 13, marginBottom: 14 }}>
            A record of removed accounts — by an admin or by the user themselves. The accounts no longer exist.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {deletedUsers.map(d => {
              const fullName = [d.first_name, d.last_name].filter(Boolean).join(" ");
              const byText = d.deleted_by_self ? "by themself" : `by ${d.deleted_by_label ?? "an admin"}`;
              return (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fafafa", borderRadius: 10, padding: "10px 14px", border: "1px solid #eee", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    {fullName && <div style={{ fontWeight: 700, fontSize: 14, color: "#374151" }}>{fullName}</div>}
                    <div style={{ fontSize: fullName ? 13 : 14, fontWeight: fullName ? 500 : 600, color: fullName ? "#6b7280" : "#374151" }}>
                      {d.email ?? "(unknown email)"}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 20,
                      background: d.deleted_by_self ? "#fef3c7" : "#e0e7ff",
                      color: d.deleted_by_self ? "#d97706" : "#4338ca",
                    }}
                  >
                    {byText}
                  </span>
                  <span className="subtle" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {new Date(d.deleted_at).toLocaleDateString()} {new Date(d.deleted_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// Dropdown to assign an email (user row or whitelist row) to a student group.
function GroupSelect({ groups, value, onChange }: { groups: StudentGroup[]; value: string | undefined; onChange: (groupId: string | null) => void }) {
  return (
    <select
      value={value ?? ""}
      onChange={e => onChange(e.target.value || null)}
      title="Assign to a student group (copies the group's locked song topics onto this account)"
      style={{ fontSize: 12, padding: "5px 8px", borderRadius: 8, border: `1px solid ${value ? PINK : "#d1d5db"}`, background: "#fff", color: value ? "#111827" : "#9ca3af", maxWidth: 160, fontWeight: value ? 600 : 400 }}
    >
      <option value="">No group</option>
      {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );
}

function UserList({
  users,
  isWhitelisted,
  onApprove,
  onDisable,
  onRemove,
  onDelete,
  onExpiry,
  onPermissions,
  expiryToInputDate,
  busy,
  groups,
  groupAssignments,
  onAssignGroup,
}: {
  users: AppUser[];
  isWhitelisted: (email: string) => boolean;
  onApprove?: (u: AppUser) => void;
  onDisable?: (u: AppUser) => void;
  onRemove?: (u: AppUser) => void;
  onDelete?: (u: AppUser) => void;
  onExpiry?: (u: AppUser, dateStr: string | null) => void;
  onPermissions?: (email: string, name: string) => void;
  expiryToInputDate?: (iso: string | null) => string;
  busy: Record<string, boolean>;
  groups?: StudentGroup[];
  groupAssignments?: Record<string, string>;
  onAssignGroup?: (email: string, groupId: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {users.map(user => {
        const statusInfo = STATUS_LABEL[user.access_status] ?? STATUS_LABEL.no_record;
        const isBusy = busy[user.id];
        const whitelisted = isWhitelisted(user.email);
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ");
        const expiryInputValue = expiryToInputDate ? expiryToInputDate(user.access_expires_at) : "";
        return (
          <div key={user.id} style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", borderRadius: 10, padding: "12px 14px", border: "1px solid #e5e7eb", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              {fullName && (
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{fullName}</div>
              )}
              <div style={{ fontWeight: fullName ? 500 : 600, fontSize: fullName ? 13 : 14, color: fullName ? "#6b7280" : "#111827", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: fullName ? 1 : 0 }}>
                {user.email}
                {whitelisted && (
                  <span style={{ fontSize: 10, fontWeight: 700, background: "#e0f2fe", color: "#0369a1", borderRadius: 20, padding: "1px 8px" }}>
                    Whitelisted
                  </span>
                )}
              </div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 2 }}>
                Joined {new Date(user.created_at).toLocaleDateString()}
                {user.chinese_pref && ` · ${user.chinese_pref === "simplified" ? "简体" : "繁體"}`}
                {user.approved_at && ` · Approved ${new Date(user.approved_at).toLocaleDateString()}`}
              </div>
            </div>

            <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: statusInfo.bg, color: statusInfo.color }}>
              {statusInfo.label}
            </span>

            {onExpiry && (
              <ExpiryField initial={expiryInputValue} disabled={isBusy} onCommit={(d) => onExpiry(user, d)} />
            )}

            {onAssignGroup && (
              <GroupSelect groups={groups ?? []} value={groupAssignments?.[user.email.toLowerCase()]} onChange={(gid) => onAssignGroup(user.email, gid)} />
            )}

            {onPermissions && (
              <button
                onClick={() => onPermissions(user.email, fullName)}
                disabled={isBusy}
                title="Edit which song topics this account can view"
                style={{ fontSize: 13, padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${PINK}`, color: PINK, background: "#fff", cursor: "pointer", whiteSpace: "nowrap", fontWeight: 600 }}
              >
                🔒 Song Topics
              </button>
            )}

            {onApprove && (
              <button
                className="btn btn-primary"
                onClick={() => onApprove(user)}
                disabled={isBusy}
                style={{ fontSize: 13, padding: "6px 14px" }}
              >
                {isBusy ? "…" : "Approve"}
              </button>
            )}

            {onDisable && (
              <button
                onClick={() => onDisable(user)}
                disabled={isBusy}
                style={{ fontSize: 13, padding: "6px 14px", borderRadius: 8, border: "1.5px solid #fca5a5", color: "#dc2626", background: "#fff", cursor: "pointer" }}
              >
                {isBusy ? "…" : "Disable"}
              </button>
            )}

            {onRemove && user.access_status === "pending" && (
              <button
                onClick={() => onRemove(user)}
                disabled={isBusy}
                style={{ fontSize: 13, padding: "6px 14px", borderRadius: 8, border: "1.5px solid #d1d5db", color: "#6b7280", background: "#fff", cursor: "pointer" }}
              >
                {isBusy ? "…" : "Remove"}
              </button>
            )}

            {onDelete && (
              <button
                onClick={() => onDelete(user)}
                disabled={isBusy}
                style={{ fontSize: 13, padding: "6px 14px", borderRadius: 8, border: "1.5px solid #fca5a5", color: "#dc2626", background: "#fff", cursor: "pointer" }}
              >
                {isBusy ? "…" : "Delete User"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Expiry date field ─────────────────────────────────────────────────────────
// Keeps the picked date in local state and only commits to the server on blur (or
// the clear button). Committing on every onChange used to fire an RPC + full reload
// per keystroke, which reset the field and prevented finishing the date.
function ExpiryField({
  initial,
  disabled,
  onCommit,
}: {
  initial: string;
  disabled?: boolean;
  onCommit: (dateStr: string | null) => void;
}) {
  const [value, setValue] = useState(initial);

  // Re-sync when the upstream (server) value changes, e.g. after a successful save/reload.
  useEffect(() => { setValue(initial); }, [initial]);

  function commit(next: string) {
    const normalized = next || null;
    // Skip the network call + reload if nothing actually changed.
    if ((initial || null) === normalized) return;
    onCommit(normalized);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
      <label style={{ fontSize: 10, color: "#6b7280", fontWeight: 600 }}>Expires (midnight PDT)</label>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="date"
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={() => commit(value)}
          disabled={disabled}
          style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db" }}
        />
        {value && (
          <button
            onClick={() => { setValue(""); commit(""); }}
            disabled={disabled}
            title="Clear expiry"
            style={{ fontSize: 11, color: "#6b7280", background: "none", border: "none", cursor: "pointer", padding: "0 4px" }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Song-topic permissions modal ──────────────────────────────────────────────

function PermissionsModal({
  email,
  name,
  categories,
  lessons,
  initialLocked,
  loading,
  saving,
  onCancel,
  onSave,
}: {
  email: string;
  name: string;
  categories: Category[];
  lessons: Lesson[];
  initialLocked: Set<string>;
  loading: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: (lockedIds: string[]) => void;
}) {
  // Working set of locked lesson ids (presence = locked for this account).
  const [locked, setLocked] = useState<Set<string>>(new Set(initialLocked));

  // Re-sync when the loaded locks arrive (modal mounts before the RPC resolves).
  useEffect(() => { setLocked(new Set(initialLocked)); }, [initialLocked]);

  // Build ordered sections: each level, then an "Unleveled" bucket for null category.
  const sections = useMemo(() => {
    const byCat = (catId: string | null) =>
      lessons
        .filter(l => l.category_id === catId)
        .sort((a, b) => a.order_index - b.order_index);
    const result: { id: string; name: string; items: Lesson[] }[] =
      categories.map(c => ({ id: c.id, name: c.name, items: byCat(c.id) }));
    const unleveled = byCat(null);
    if (unleveled.length > 0) result.push({ id: UNLEVELED_ID, name: "Unleveled", items: unleveled });
    return result.filter(s => s.items.length > 0);
  }, [categories, lessons]);

  const fullName = name;
  const allLocked = lessons.length > 0 && lessons.every(l => locked.has(l.id));

  function toggleLesson(id: string) {
    setLocked(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSection(items: Lesson[]) {
    const allOn = items.every(l => locked.has(l.id));
    setLocked(prev => {
      const next = new Set(prev);
      items.forEach(l => (allOn ? next.delete(l.id) : next.add(l.id)));
      return next;
    });
  }

  function toggleAll() {
    setLocked(allLocked ? new Set() : new Set(lessons.map(l => l.id)));
  }

  const dirty =
    locked.size !== initialLocked.size ||
    [...locked].some(id => !initialLocked.has(id));

  const LockGlyph = ({ on }: { on: boolean }) => (
    <span style={{ fontSize: 16, lineHeight: 1, filter: on ? "none" : "grayscale(1)", opacity: on ? 1 : 0.45 }}>
      {on ? "🔒" : "🔓"}
    </span>
  );

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 9000 }}
        onMouseDown={onCancel}
      />
      <div
        onMouseDown={e => e.stopPropagation()}
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          zIndex: 9001, background: "#fff", borderRadius: 16,
          boxShadow: "0 8px 40px rgba(0,0,0,0.2)", width: 560, maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ padding: "20px 24px 14px", borderBottom: "1px solid #f0f0f0" }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#111827" }}>Song Topic Permissions</div>
          <div className="subtle" style={{ fontSize: 13, marginTop: 2 }}>
            {fullName ? `${fullName} · ` : ""}{email}
          </div>
          <div className="subtle" style={{ fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            Locked song topics appear with a 🔒 in this account's app and can't be opened. Everything starts unlocked.
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "#6b7280" }}>Loading…</div>
        ) : (
          <>
            {/* Toolbar */}
            <div style={{ padding: "12px 24px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="subtle" style={{ fontSize: 12, fontWeight: 600 }}>
                {locked.size} of {lessons.length} locked
              </span>
              <button
                onClick={toggleAll}
                disabled={lessons.length === 0}
                style={{ fontSize: 13, fontWeight: 700, padding: "6px 14px", borderRadius: 8, border: "1.5px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer" }}
              >
                {allLocked ? "Unlock All" : "Lock All"}
              </button>
            </div>

            {/* List */}
            <div style={{ overflowY: "auto", padding: "8px 24px 16px", flex: 1 }}>
              {sections.length === 0 && (
                <div className="subtle" style={{ fontSize: 14, padding: "20px 0", textAlign: "center" }}>No song topics yet.</div>
              )}
              {sections.map(section => {
                const sectionLocked = section.items.every(l => locked.has(l.id));
                return (
                  <div key={section.id} style={{ marginTop: 16 }}>
                    {/* Level header (click toggles whole level) */}
                    <button
                      onClick={() => toggleSection(section.items)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 10,
                        background: sectionLocked ? "#fdf2f8" : "#f9fafb", border: "1px solid #e5e7eb",
                        borderRadius: 10, padding: "10px 12px", cursor: "pointer", textAlign: "left",
                      }}
                    >
                      <LockGlyph on={sectionLocked} />
                      <span style={{ flex: 1, fontWeight: 700, fontSize: 14, color: "#111827" }}>{section.name}</span>
                      <span className="subtle" style={{ fontSize: 12 }}>
                        {section.items.filter(l => locked.has(l.id)).length}/{section.items.length} locked
                      </span>
                    </button>

                    {/* Topics */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4, paddingLeft: 8 }}>
                      {section.items.map(lesson => {
                        const on = locked.has(lesson.id);
                        return (
                          <button
                            key={lesson.id}
                            onClick={() => toggleLesson(lesson.id)}
                            style={{
                              display: "flex", alignItems: "center", gap: 10,
                              background: "#fff", border: "1px solid #f0f0f0", borderRadius: 8,
                              padding: "8px 12px", cursor: "pointer", textAlign: "left",
                            }}
                          >
                            <LockGlyph on={on} />
                            <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: on ? "#111827" : "#374151" }}>
                              {lesson.title}
                            </span>
                            {lesson.is_locked && (
                              <span style={{ fontSize: 10, fontWeight: 700, background: "#fef3c7", color: "#d97706", borderRadius: 20, padding: "1px 8px" }}>
                                Locked for everyone
                              </span>
                            )}
                            {!lesson.is_published && (
                              <span style={{ fontSize: 10, fontWeight: 700, background: "#f3f4f6", color: "#6b7280", borderRadius: 20, padding: "1px 8px" }}>
                                Draft
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div style={{ padding: "14px 24px", borderTop: "1px solid #f0f0f0", display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={onCancel}
                disabled={saving}
                style={{ padding: "8px 18px", fontSize: 13 }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => onSave([...locked])}
                disabled={saving || !dirty}
                style={{ padding: "8px 18px", fontSize: 13 }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
