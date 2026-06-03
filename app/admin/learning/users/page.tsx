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
  const [loading, setLoading] = useState(true);

  // Song-topic permissions modal. Keyed by EMAIL so the same locks are edited
  // whether opened from an existing user row or a whitelist entry (no account yet).
  const [permTarget, setPermTarget] = useState<{ email: string; name: string } | null>(null);
  const [permInitialLocked, setPermInitialLocked] = useState<Set<string>>(new Set());
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});
  const [newEmail, setNewEmail] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [addingEmail, setAddingEmail] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    const [{ data: uData }, { data: wData }, { data: aData }, { data: cData }, { data: lData }, { data: dData }] = await Promise.all([
      supabase.rpc("admin_list_learning_users"),
      supabase.from("learning_email_whitelist").select("*").order("added_at", { ascending: false }),
      supabase.from("learning_approved_emails").select("email"),
      supabase.from("learning_categories").select("id, name, order_index").order("order_index"),
      supabase.from("learning_lessons").select("id, category_id, title, is_locked, is_published, order_index").order("order_index"),
      supabase.rpc("admin_list_deleted_users"),
    ]);
    setUsers((uData ?? []) as AppUser[]);
    setWhitelist((wData ?? []) as WhitelistEntry[]);
    setApprovedEmails(((aData ?? []) as { email: string }[]).map(r => r.email.toLowerCase()));
    setCategories((cData ?? []) as Category[]);
    setLessons((lData ?? []) as Lesson[]);
    setDeletedUsers((dData ?? []) as DeletedUser[]);
    setLoading(false);
  }

  function isWhitelisted(email: string) {
    const lower = email.toLowerCase();
    return whitelist.some(w => w.email === lower) || approvedEmails.includes(lower);
  }

  async function approveUser(user: AppUser) {
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

  async function setExpiry(user: AppUser, dateStr: string | null) {
    setBusy(user.id, true);
    setError("");
    const { error: e } = await supabase.rpc("admin_set_learning_expiry", {
      target_user_id: user.id,
      expiry_date: dateStr || null,
    });
    if (e) {
      setError(e.message);
    } else {
      // Recompute the displayed timestamp: midnight LA on the picked day
      let iso: string | null = null;
      if (dateStr) {
        // Build a Date matching LA local midnight; not perfect with DST but accurate to the day
        iso = new Date(`${dateStr}T00:00:00-07:00`).toISOString();
      }
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, access_expires_at: iso } : u));
      // Background cron will flip status to disabled once the timestamp passes; reload to reflect
      await loadAll();
    }
    setBusy(user.id, false);
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
    setPermTarget({ email, name });
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

  async function savePermissions(lockedIds: string[]) {
    if (!permTarget) return;
    setPermSaving(true);
    setError("");
    const { error: e } = await supabase.rpc("admin_set_email_lesson_locks", {
      p_email: permTarget.email,
      locked_lesson_ids: lockedIds,
    });
    if (e) setError(e.message);
    else setPermTarget(null);
    setPermSaving(false);
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
  const approved = users.filter(u => u.access_status === "approved");
  const disabled = users.filter(u => u.access_status === "disabled");

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
        <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Email Whitelist</h2>
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

        {whitelist.length === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No whitelisted emails yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {whitelist.map(entry => (
              <div key={entry.email} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f9fafb", borderRadius: 8, padding: "8px 12px", border: "1px solid #e5e7eb" }}>
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{entry.email}</span>
                {entry.notes && <span className="subtle" style={{ fontSize: 12 }}>{entry.notes}</span>}
                <span className="subtle" style={{ fontSize: 11 }}>{new Date(entry.added_at).toLocaleDateString()}</span>
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
          />
        )}
      </section>

      {/* Approved */}
      {approved.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Approved ({approved.length})</h2>
          <UserList
            users={approved}
            isWhitelisted={isWhitelisted}
            onDisable={disableUser}
            onDelete={deleteUser}
            onExpiry={setExpiry}
            expiryToInputDate={expiryToInputDate}
            busy={actionBusy}
            onPermissions={openPermissions}
          />
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
              <ExpiryField user={user} initial={expiryInputValue} disabled={isBusy} onCommit={onExpiry} />
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
  user,
  initial,
  disabled,
  onCommit,
}: {
  user: AppUser;
  initial: string;
  disabled?: boolean;
  onCommit: (u: AppUser, dateStr: string | null) => void;
}) {
  const [value, setValue] = useState(initial);

  // Re-sync when the upstream (server) value changes, e.g. after a successful save/reload.
  useEffect(() => { setValue(initial); }, [initial]);

  function commit(next: string) {
    const normalized = next || null;
    // Skip the network call + reload if nothing actually changed.
    if ((initial || null) === normalized) return;
    onCommit(user, normalized);
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
