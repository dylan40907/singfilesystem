"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";

/**
 * Portal-account actions for an employee, consolidated here from the old
 * /teachers and /admin/supervisors pages. Renders nothing when the employee has
 * no linked portal account.
 */
export default function EmployeeAccountActions({
  profileId,
  role,
  isActive,
  displayName,
  canManage,
  onChanged,
}: {
  profileId: string | null;
  role: string | null;
  isActive: boolean;
  displayName: string;
  /** Viewer is allowed to run these actions on this account. */
  canManage: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const { confirm, modal } = useDialog();
  const [busy, setBusy] = useState<"reset" | "phone" | "active" | "delete" | null>(null);
  const [status, setStatus] = useState("");

  if (!profileId || !canManage) return <>{modal}</>;

  async function resetPassword() {
    const ok = await confirm(
      `Reset password for ${displayName}?\n\nThey will need to use "Set up an account" again.`,
      { title: "Reset password", confirmLabel: "Reset" }
    );
    if (!ok) return;
    setBusy("reset"); setStatus("Resetting password…");
    try {
      const { error } = await supabase.functions.invoke("admin-reset-user-password", { body: { target_user_id: profileId } });
      if (error) throw error;
      setStatus("✅ Password reset.");
    } catch (e: any) {
      setStatus("Reset password error: " + (e?.message ?? "unknown"));
    } finally { setBusy(null); }
  }

  async function resetPhone() {
    const ok = await confirm(
      `Reset two-step phone for ${displayName}?\n\nThey'll set up a new phone number the next time they sign in.`,
      { title: "Reset phone", confirmLabel: "Reset" }
    );
    if (!ok) return;
    setBusy("phone"); setStatus("Resetting phone…");
    try {
      const { error } = await supabase.rpc("admin_reset_user_phone", { target_user_id: profileId });
      if (error) throw error;
      setStatus("✅ Phone reset — they'll re-enroll at next sign-in.");
    } catch (e: any) {
      setStatus("Reset phone error: " + (e?.message ?? "unknown"));
    } finally { setBusy(null); }
  }

  async function setActive(next: boolean) {
    const ok = await confirm(
      `${next ? "Activate" : "Deactivate"} ${displayName}?\n\n${
        next ? "They will be able to log in again." : "They will be signed out and won't be able to log in."
      }`,
      { title: next ? "Activate account" : "Deactivate account", confirmLabel: next ? "Activate" : "Deactivate", danger: !next }
    );
    if (!ok) return;
    setBusy("active"); setStatus(next ? "Activating…" : "Deactivating…");
    try {
      const { error } = await supabase.functions.invoke("admin-set-user-active", {
        body: { target_user_id: profileId, is_active: next },
      });
      if (error) throw error;
      setStatus(next ? "✅ Activated." : "✅ Deactivated.");
      await onChanged();
    } catch (e: any) {
      setStatus((next ? "Activate" : "Deactivate") + " error: " + (e?.message ?? "unknown"));
    } finally { setBusy(null); }
  }

  async function deleteAccount() {
    const ok = await confirm(
      `Delete the portal account for ${displayName}?\n\nThis cannot be undone.`,
      { title: "Delete account", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    setBusy("delete"); setStatus("Deleting…");
    try {
      // Supervisors and teachers have separate delete functions.
      const fn = role === "supervisor" ? "admin-delete-supervisor" : "admin-delete-teacher";
      const body = role === "supervisor" ? { supervisor_id: profileId } : { teacher_id: profileId };
      const { error } = await supabase.functions.invoke(fn, { body });
      if (error) throw error;
      setStatus("✅ Account deleted.");
      await onChanged();
    } catch (e: any) {
      setStatus("Delete error: " + (e?.message ?? "unknown"));
    } finally { setBusy(null); }
  }

  return (
    <>
      {modal}
      {status ? <span className="badge badge-pink" style={{ marginRight: 4 }}>{status}</span> : null}
      <button className="btn" onClick={() => void resetPassword()} disabled={busy !== null} title="Reset this account's password">
        {busy === "reset" ? "Resetting…" : "Reset password"}
      </button>
      <button className="btn" onClick={() => void resetPhone()} disabled={busy !== null} title="Force two-step phone re-enrollment">
        {busy === "phone" ? "Resetting…" : "Reset phone"}
      </button>
      <button className="btn" onClick={() => void setActive(!isActive)} disabled={busy !== null}
        title={isActive ? "Deactivate this account" : "Activate this account"}>
        {busy === "active" ? "Saving…" : isActive ? "Deactivate" : "Activate"}
      </button>
      <button className="btn" onClick={() => void deleteAccount()} disabled={busy !== null}
        title="Delete this portal account" style={{ padding: "8px 10px", color: "#b91c1c" }}>
        {busy === "delete" ? "…" : "🗑"}
      </button>
    </>
  );
}
