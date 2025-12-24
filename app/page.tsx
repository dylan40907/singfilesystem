"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { createFolder, fetchFolders, fetchRootFolder, Folder } from "@/lib/folders";
import { fetchActiveTeachers, fetchMyProfile, TeacherProfile } from "@/lib/teachers";
import { shareFolderWithTeacher } from "@/lib/permissions";
import { fetchSharedFoldersDirect } from "@/lib/shared";
import { createFileRow, fetchFilesInFolder, FileRow } from "@/lib/files";

async function readJsonSafely(res: Response) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!ct.includes("application/json")) return { __nonJson: true, text };
  try {
    return JSON.parse(text);
  } catch {
    return { __nonJson: true, text };
  }
}

type FolderPermissionRow = {
  permission_id: string;
  principal_user_id: string;
  email: string | null;
  access: "view" | "download" | "manage";
  inherit: boolean;
  created_at: string;
};

function labelForTeacher(t: TeacherProfile) {
  const name = ((t as any).full_name ?? "").trim();
  const email = (t.email ?? "").trim();
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  return t.id;
}

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="btn"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 10px",
        borderRadius: 10,
        border: "1px solid var(--border)",
        background: disabled ? "rgba(0,0,0,0.04)" : "white",
        fontWeight: 800,
        fontSize: 12,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

type DeleteTarget =
  | { type: "folder"; id: string; name: string }
  | { type: "file"; id: string; name: string };

type EditTarget =
  | { type: "folder"; id: string; name: string; parent_id: string | null }
  | { type: "file"; id: string; name: string; folder_id: string };

type PreviewMode = "pdf" | "image" | "text" | "office" | "unknown";

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function isOfficeExt(ext: string) {
  return ext === "docx" || ext === "pptx" || ext === "xlsx";
}
function isPdfExt(ext: string) {
  return ext === "pdf";
}
function isImageExt(ext: string) {
  return ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || ext === "svg";
}
function isTextExt(ext: string) {
  return ext === "txt" || ext === "md" || ext === "csv" || ext === "json" || ext === "log";
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

type SetupCheckResult =
  | { status: "not_found" }
  | { status: "has_password" }
  | { status: "no_password"; user_id?: string; full_name?: string | null };

export default function Home() {
  // Auth
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);

  // Profile
  const [myProfile, setMyProfile] = useState<TeacherProfile | null>(null);

  // Data
  const [folders, setFolders] = useState<Folder[]>([]);
  const [rootFolder, setRootFolder] = useState<Folder | null>(null);
  const [sharedFolders, setSharedFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);

  // Navigation
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);

  // UI
  const [newFolderName, setNewFolderName] = useState("");
  const [status, setStatus] = useState("");

  // Teachers (for sharing modal)
  const [teachers, setTeachers] = useState<TeacherProfile[]>([]);

  // Upload UI
  const [uploading, setUploading] = useState(false);

  // Folder access list (admin/supervisor only) — shown in share modal
  const [folderPerms, setFolderPerms] = useState<FolderPermissionRow[]>([]);
  const [folderPermsLoading, setFolderPermsLoading] = useState(false);

  // Share modal state
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<{ folderId: string; label: string } | null>(null);
  const [shareChecked, setShareChecked] = useState<Set<string>>(new Set());

  // Delete confirm modal
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  // Edit (rename/move) modal
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editName, setEditName] = useState("");
  const [editMoveFolderId, setEditMoveFolderId] = useState<string>("");

  // Preview modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("unknown");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewSignedUrl, setPreviewSignedUrl] = useState<string>("");
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string>(""); // blob url (pdf/image)
  const [previewText, setPreviewText] = useState<string>("");

  // ---------------------------
  // NEW: Teacher setup modal state
  // ---------------------------
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState<"email" | "password">("email");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupCheck, setSetupCheck] = useState<SetupCheckResult | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupCheckedEmail, setSetupCheckedEmail] = useState<string>("");

  const [setupPass1, setSetupPass1] = useState("");
  const [setupPass2, setSetupPass2] = useState("");
  const [setupSetPassLoading, setSetupSetPassLoading] = useState(false);

  const isAdminOrSupervisor =
    myProfile?.is_active && (myProfile.role === "admin" || myProfile.role === "supervisor");
  const canManageFiles = !!isAdminOrSupervisor;

  async function refreshFiles(folderId: string | null) {
    if (!folderId) {
      setFiles([]);
      return;
    }
    try {
      const f = await fetchFilesInFolder(folderId);
      setFiles(f);
    } catch (e: any) {
      setStatus("Error loading files: " + (e?.message ?? "unknown"));
    }
  }

  async function refreshFolderPermissions(folderId: string | null) {
    if (!isAdminOrSupervisor || !folderId) {
      setFolderPerms([]);
      return;
    }
    setFolderPermsLoading(true);
    try {
      const { data, error } = await supabase.rpc("list_folder_permissions", {
        folder_uuid: folderId,
      });
      if (error) throw error;
      setFolderPerms((data ?? []) as FolderPermissionRow[]);
    } catch (e: any) {
      setStatus("Error loading folder permissions: " + (e?.message ?? "unknown"));
      setFolderPerms([]);
    } finally {
      setFolderPermsLoading(false);
    }
  }

  async function revokePermission(permissionId: string) {
    if (!isAdminOrSupervisor) return;
    setStatus("Revoking permission...");
    try {
      const { error } = await supabase.rpc("revoke_permission", {
        permission_uuid: permissionId,
      });
      if (error) throw error;

      setStatus("✅ Permission revoked.");
      await refreshFolderPermissions(shareTarget?.folderId ?? currentFolderId);
    } catch (e: any) {
      setStatus("Revoke error: " + (e?.message ?? "unknown"));
    }
  }

  async function refreshAll() {
    setStatus("Loading...");
    const { data: sessionData } = await supabase.auth.getSession();
    const userEmail = sessionData.session?.user?.email ?? null;
    setSessionEmail(userEmail);

    if (!userEmail) {
      setMyProfile(null);
      setFolders([]);
      setRootFolder(null);
      setSharedFolders([]);
      setCurrentFolderId(null);
      setTeachers([]);
      setFiles([]);
      setFolderPerms([]);
      setStatus("Not signed in.");
      return;
    }

    try {
      const profile = await fetchMyProfile();
      setMyProfile(profile);

      const [allFolders, root, shared] = await Promise.all([
        fetchFolders(),
        fetchRootFolder(),
        fetchSharedFoldersDirect(),
      ]);

      setFolders(allFolders);
      setRootFolder(root);
      setSharedFolders(shared);

      // Default starting folder
      let nextFolder = currentFolderId;
      if (!nextFolder) {
        if (root) nextFolder = root.id;
        else if (shared.length > 0) nextFolder = shared[0].id;
        else nextFolder = null;
      }
      setCurrentFolderId(nextFolder);

      // Teacher list only for admins/supervisors (for share modal)
      if (profile?.is_active && (profile.role === "admin" || profile.role === "supervisor")) {
        const teacherList = await fetchActiveTeachers();
        setTeachers(teacherList);
      } else {
        setTeachers([]);
      }

      await refreshFiles(nextFolder);
      await refreshFolderPermissions(nextFolder);

      setStatus("");
    } catch (e: any) {
      setStatus("Error: " + (e?.message ?? "unknown"));
    }
  }

  async function signIn() {
    setStatus("Signing in...");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setStatus("Sign-in error: " + error.message);
      return;
    }
    await refreshAll();
  }

  // ---------------------------
  // NEW: Setup modal handlers
  // ---------------------------
  function openSetupModal() {
    setSetupOpen(true);
    setSetupStep("email");
    setSetupEmail("");
    setSetupCheck(null);
    setSetupCheckedEmail("");
    setSetupLoading(false);
    setSetupPass1("");
    setSetupPass2("");
    setSetupSetPassLoading(false);
    // don't wipe main status completely; but do clear "Not signed in." noise
    setStatus("");
  }

  function closeSetupModal() {
    if (setupLoading || setupSetPassLoading) return;
    setSetupOpen(false);
    setSetupStep("email");
    setSetupEmail("");
    setSetupCheck(null);
    setSetupPass1("");
    setSetupPass2("");
  }

  async function runSetupCheck() {
    const e = setupEmail.trim().toLowerCase();
    if (!e || !isValidEmail(e)) {
      setStatus("Setup error: Please enter a valid email.");
      return;
    }

    setSetupLoading(true);
    setSetupCheck(null);
    setStatus("Checking account...");

    try {
      const { data, error } = await supabase.functions.invoke("teacher-setup-check", {
        body: { email: e },
      });

      if (error) {
        setStatus("Setup error: " + (error.message ?? "Edge Function error"));
        return;
      }

      const result = data as SetupCheckResult;
      setSetupCheck(result);

      if (result.status === "not_found") {
        setStatus("No account found for that email. Ask an admin to create one.");
        return;
      }

      if (result.status === "has_password") {
        setStatus("That email is already in use and already has a password. Please sign in normally.");
        return;
      }

      // no_password
      setStatus("Account found. Please set a password.");
      setSetupCheckedEmail(e);
      setSetupStep("password");
    } catch (err: any) {
      setStatus("Setup error: " + (err?.message ?? "unknown"));
    } finally {
      setSetupLoading(false);
    }
  }

  async function runSetupSetPassword() {
    const e = setupEmail.trim().toLowerCase();
    if (!e || !isValidEmail(e)) {
      setStatus("Setup error: invalid email.");
      return;
    }

    if (!setupCheck || setupCheck.status !== "no_password" ||  setupCheckedEmail !== e) {
      setStatus("Setup error: Please check your email first.");
      return;
    }

    if (setupPass1.length < 8) {
      setStatus("Setup error: Password must be at least 8 characters.");
      return;
    }
    if (setupPass1 !== setupPass2) {
      setStatus("Setup error: Passwords do not match.");
      return;
    }

    setSetupSetPassLoading(true);
    setStatus("Setting password...");

    try {
      const { error } = await supabase.functions.invoke("teacher-setup-set-password", {
        body: { email: e, password: setupPass1 },
      });

      if (error) {
        setStatus("Setup error: " + (error.message ?? "Edge Function error"));
        return;
      }

      // now sign in with the newly set password
      setStatus("✅ Password set. Signing in...");

      const { error: signErr } = await supabase.auth.signInWithPassword({
        email: e,
        password: setupPass1,
      });

      if (signErr) {
        setStatus("Password set, but sign-in failed: " + signErr.message);
        return;
      }

      closeSetupModal();
      await refreshAll();
      setStatus("✅ Account setup complete.");
    } catch (err: any) {
      setStatus("Setup error: " + (err?.message ?? "unknown"));
    } finally {
      setSetupSetPassLoading(false);
    }
  }

  async function handleCreateFolder() {
    if (!newFolderName.trim() || !currentFolderId) return;
    try {
      await createFolder(newFolderName.trim(), currentFolderId);
      setNewFolderName("");
      await refreshAll();
    } catch (e: any) {
      setStatus("Create error: " + (e?.message ?? "unknown"));
    }
  }

  // ---------------------------
  // Upload (multi-file)
  // ---------------------------
  async function uploadSingleFileWithToken(file: File, token: string, folderId: string) {
    const presignRes = await fetch("/api/r2/presign", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        folderId,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    });

    const presignBody = await readJsonSafely(presignRes);

    if (!presignRes.ok) {
      const msg =
        (presignBody as any)?.error ||
        ((presignBody as any)?.__nonJson ? (presignBody as any).text.slice(0, 300) : "presign failed");
      throw new Error(msg);
    }

    if ((presignBody as any)?.__nonJson) {
      throw new Error("Presign returned non-JSON response. Check server route/env.");
    }

    const { uploadUrl, objectKey } = presignBody as any;
    if (!uploadUrl || !objectKey) throw new Error("Presign response missing uploadUrl/objectKey");

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);

    await createFileRow({
      folderId,
      name: file.name,
      objectKey,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    });
  }

  async function handleUploadSelectedFiles(fileList: FileList | null) {
    if (!isAdminOrSupervisor) return;
    if (!currentFolderId) return;

    const filesArr = Array.from(fileList ?? []);
    if (filesArr.length === 0) return;

    setUploading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No session token");

      for (let i = 0; i < filesArr.length; i++) {
        const file = filesArr[i];
        setStatus(`Uploading ${i + 1}/${filesArr.length}: ${file.name}`);
        await uploadSingleFileWithToken(file, token, currentFolderId);
      }

      setStatus(`✅ Upload complete (${filesArr.length} file${filesArr.length === 1 ? "" : "s"}).`);
      await refreshFiles(currentFolderId);
    } catch (e: any) {
      setStatus("Upload error: " + (e?.message ?? "unknown"));
    } finally {
      setUploading(false);
    }
  }

  // ---------------------------
  // Download helpers
  // ---------------------------
  async function getSignedDownloadUrl(fileId: string, mode: "inline" | "attachment" = "attachment") {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) throw new Error("No session token");

    const res = await fetch("/api/r2/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ fileId, mode }),
    });

    const body = await readJsonSafely(res);

    if (!res.ok) {
      const msg =
        (body as any)?.error ||
        ((body as any)?.__nonJson ? (body as any).text.slice(0, 300) : "download failed");
      throw new Error(msg);
    }
    if ((body as any)?.__nonJson) throw new Error("Download returned non-JSON response.");
    if (!(body as any).url) throw new Error("Download response missing url");
    return (body as any).url as string;
  }

  async function handleDownload(fileId: string) {
    if (!isAdminOrSupervisor) {
      setStatus("Downloads are disabled for teacher accounts. Ask a supervisor.");
      return;
    }
    try {
      const url = await getSignedDownloadUrl(fileId, "attachment");
      window.location.href = url;
    } catch (e: any) {
      setStatus("Download error: " + (e?.message ?? "unknown"));
    }
  }

  // ---------------------------
  // Folder ZIP download (recursive)
  // ---------------------------
  function buildChildrenByParentMap() {
    const map = new Map<string, Folder[]>();
    for (const f of folders) {
      if (!f.parent_id) continue;
      const arr = map.get(f.parent_id) ?? [];
      arr.push(f);
      map.set(f.parent_id, arr);
    }
    // stable-ish ordering
    for (const [k, arr] of map.entries()) {
      arr.sort((a, b) => a.name.localeCompare(b.name));
      map.set(k, arr);
    }
    return map;
  }

  async function collectFolderFileEntries(folderId: string, basePath: string) {
    // Returns entries: { url, pathInZip }
    const childrenByParent = buildChildrenByParentMap();

    const entries: { url: string; path: string }[] = [];
    const stack: Array<{ folderId: string; path: string }> = [{ folderId, path: basePath }];

    // We fetch files per folder on-demand via fetchFilesInFolder (RLS enforced client-side)
    while (stack.length) {
      const cur = stack.pop()!;
      setStatus(`Collecting: ${cur.path || basePath}…`);

      const fileRows = await fetchFilesInFolder(cur.folderId);
      for (const fr of fileRows) {
        const url = await getSignedDownloadUrl(fr.id);
        entries.push({ url, path: `${cur.path}/${fr.name}`.replaceAll("//", "/") });
      }

      const kids = childrenByParent.get(cur.folderId) ?? [];
      for (const child of kids) {
        stack.push({ folderId: child.id, path: `${cur.path}/${child.name}`.replaceAll("//", "/") });
      }
    }

    return entries;
  }

  async function handleDownloadFolderAsZip(folderId: string, folderName: string) {
    try {
      setStatus("Preparing ZIP…");

      const safeName = (folderName || "folder").replaceAll(/[\\/:*?"<>|]+/g, "_");
      const entries = await collectFolderFileEntries(folderId, safeName);

      if (entries.length === 0) {
        setStatus("Nothing to download (folder has no files).");
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("No session token");

      setStatus(`Zipping ${entries.length} file${entries.length === 1 ? "" : "s"}…`);

      const zipRes = await fetch("/api/zip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          zipName: safeName,
          files: entries,
        }),
      });

      if (!zipRes.ok) {
        const msg = (await zipRes.text()).slice(0, 400);
        throw new Error(`ZIP failed (${zipRes.status}): ${msg}`);
      }

      const blob = await zipRes.blob();
      const dlUrl = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = dlUrl;
      a.download = `${safeName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(dlUrl), 60_000);

      setStatus("✅ Download started.");
    } catch (e: any) {
      setStatus("Folder download error: " + (e?.message ?? "unknown"));
    }
  }

  // ---------------------------
  // Preview (fullscreen modal)
  // ---------------------------
  function closePreview() {
    setPreviewOpen(false);
    setPreviewFile(null);
    setPreviewMode("unknown");
    setPreviewLoading(false);
    setPreviewSignedUrl("");
    setPreviewText("");
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      setPreviewObjectUrl("");
    }
  }

  async function openPreview(file: FileRow) {
    setPreviewFile(file);
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewText("");

    try {
      const url = await getSignedDownloadUrl(file.id, "inline");
      setPreviewSignedUrl(url);

      const ext = extOf(file.name);

      if (isOfficeExt(ext)) {
        setPreviewMode("office");
        setPreviewLoading(false);
        return;
      }

      if (isPdfExt(ext)) {
        setPreviewMode("pdf");
        setPreviewLoading(false);
        return;
      }

      if (isImageExt(ext)) {
        setPreviewMode("image");
        setPreviewLoading(false);
        return;
      }

      if (isTextExt(ext)) {
        // simplest: render via iframe using inline URL (no CORS fetch)
        setPreviewMode("text");
        setPreviewLoading(false);
        return;
      }

      setPreviewMode("unknown");
      setPreviewLoading(false);
    } catch (e: any) {
      setStatus("Preview error: " + (e?.message ?? "unknown"));
      setPreviewMode("unknown");
      setPreviewLoading(false);
    }
  }

  // ---------------------------
  // Share modal
  // ---------------------------
  function openShareModalForFolder(folderId: string, label: string) {
    if (!isAdminOrSupervisor) return;
    setShareTarget({ folderId, label });
    setShareChecked(new Set());
    setShareModalOpen(true);
    refreshFolderPermissions(folderId);
  }

  function openShareModalForFile(file: FileRow) {
    // Permissions are folder-based right now, so share the containing folder.
    const folderId = (file as any)?.folder_id ?? currentFolderId;
    if (!folderId) return;
    openShareModalForFolder(folderId, `Folder containing: ${(file as any).name ?? "file"}`);
  }

  async function shareToSelectedTeachers() {
    if (!isAdminOrSupervisor) return;
    if (!shareTarget?.folderId) return;

    const ids = Array.from(shareChecked);
    if (ids.length === 0) return;

    setStatus("Sharing...");
    try {
      const results = await Promise.allSettled(
        ids.map((teacherId) =>
          shareFolderWithTeacher({
            teacherId,
            folderId: shareTarget.folderId,
            access: "view",
            inherit: true,
          })
        )
      );

      const ok = results.filter((r) => r.status === "fulfilled").length;
      const fail = results.length - ok;

      if (fail > 0) {
        setStatus(`⚠️ Shared with ${ok}/${results.length}. Some failed (permissions/RLS?).`);
      } else {
        setStatus(`✅ Shared with ${ok} teacher${ok === 1 ? "" : "s"}.`);
      }

      await refreshAll();
      await refreshFolderPermissions(shareTarget.folderId);
    } catch (e: any) {
      setStatus("Share error: " + (e?.message ?? "unknown"));
    }
  }

  // ---------------------------
  // Delete (confirm modal + recursive for folders)
  // ---------------------------
  function openDeleteConfirm(target: DeleteTarget) {
    if (!isAdminOrSupervisor) return;
    setDeleteTarget(target);
    setDeleteModalOpen(true);
  }

  function buildDescendants(folderId: string) {
    // Returns all descendant folder ids (excluding the folderId itself)
    const childrenByParent = new Map<string, string[]>();
    for (const f of folders) {
      if (!f.parent_id) continue;
      const arr = childrenByParent.get(f.parent_id) ?? [];
      arr.push(f.id);
      childrenByParent.set(f.parent_id, arr);
    }

    const out: string[] = [];
    const stack = [folderId];
    while (stack.length) {
      const cur = stack.pop()!;
      const kids = childrenByParent.get(cur) ?? [];
      for (const k of kids) {
        out.push(k);
        stack.push(k);
      }
    }
    return out;
  }

  function depthOfFolder(folderId: string, folderById: Map<string, Folder>) {
    let d = 0;
    let cur = folderById.get(folderId);
    const seen = new Set<string>();
    while (cur?.parent_id) {
      if (seen.has(cur.id)) break; // safety
      seen.add(cur.id);
      d++;
      cur = folderById.get(cur.parent_id);
    }
    return d;
  }

  async function deleteFileRow(fileId: string) {
    // DB delete only (R2 object cleanup can be added later)
    const { error } = await supabase.from("files").delete().eq("id", fileId);
    if (error) throw error;
  }

  async function deleteFolderRow(folderId: string) {
    const { error } = await supabase.from("folders").delete().eq("id", folderId);
    if (error) throw error;
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;

    setStatus("Deleting...");
    try {
      if (deleteTarget.type === "file") {
        await deleteFileRow(deleteTarget.id);
      } else {
        // Recursive: delete files in all descendant folders + this folder, then delete folders deepest-first
        const folderById = new Map<string, Folder>();
        for (const f of folders) folderById.set(f.id, f);

        const descendants = buildDescendants(deleteTarget.id);
        const allFolderIds = [deleteTarget.id, ...descendants];

        // Delete file rows for all those folders
        for (const fid of allFolderIds) {
          const { data, error } = await supabase.from("files").select("id").eq("folder_id", fid);
          if (error) throw error;
          const ids = (data ?? []).map((r: any) => r.id as string);
          for (const id of ids) {
            await deleteFileRow(id);
          }
        }

        // Delete folders deepest-first
        const foldersToDelete = [...allFolderIds].sort(
          (a, b) => depthOfFolder(b, folderById) - depthOfFolder(a, folderById)
        );
        for (const fid of foldersToDelete) {
          await deleteFolderRow(fid);
        }

        // If deleting the current folder, bounce to root
        if (currentFolderId === deleteTarget.id) {
          setCurrentFolderId(rootFolder?.id ?? null);
        }
      }

      setDeleteModalOpen(false);
      setDeleteTarget(null);

      setStatus("✅ Deleted.");
      await refreshAll();
    } catch (e: any) {
      setStatus("Delete error: " + (e?.message ?? "unknown"));
    }
  }

  // ---------------------------
  // Edit (rename/move) modal
  // ---------------------------
  function isDescendantFolder(possibleChildId: string, possibleAncestorId: string) {
    // Returns true if possibleChildId is inside possibleAncestorId subtree
    if (possibleChildId === possibleAncestorId) return true;
    const parentById = new Map<string, string | null>();
    for (const f of folders) parentById.set(f.id, f.parent_id ?? null);

    let cur: string | null = possibleChildId;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      if (cur === possibleAncestorId) return true;
      cur = parentById.get(cur) ?? null;
    }
    return false;
  }

  function openEditModalForFolder(folder: Folder) {
    if (!isAdminOrSupervisor) return;
    setEditTarget({ type: "folder", id: folder.id, name: folder.name, parent_id: folder.parent_id ?? null });
    setEditName(folder.name);
    setEditMoveFolderId(folder.parent_id ?? (rootFolder?.id ?? ""));
    setEditModalOpen(true);
  }

  function openEditModalForFile(file: FileRow) {
    if (!isAdminOrSupervisor) return;
    const folderId = (file as any)?.folder_id ?? currentFolderId;
    if (!folderId) return;
    setEditTarget({ type: "file", id: file.id, name: file.name, folder_id: folderId });
    setEditName(file.name);
    setEditMoveFolderId(folderId);
    setEditModalOpen(true);
  }

  async function saveEditChanges() {
    if (!editTarget) return;
    const nextName = editName.trim();
    if (!nextName) return;

    setStatus("Saving changes...");
    try {
      if (editTarget.type === "file") {
        const newFolderId = editMoveFolderId || editTarget.folder_id;
        const { error } = await supabase.from("files").update({ name: nextName, folder_id: newFolderId }).eq("id", editTarget.id);
        if (error) throw error;
      } else {
        const newParentId = editMoveFolderId || editTarget.parent_id || null;

        if (newParentId) {
          if (newParentId === editTarget.id) throw new Error("Cannot move a folder into itself.");
          if (isDescendantFolder(newParentId, editTarget.id)) throw new Error("Cannot move a folder into its descendant.");
        } else {
          if (editTarget.id !== rootFolder?.id) {
            throw new Error("Cannot move a folder to null parent. Choose a destination folder.");
          }
        }

        const { error } = await supabase.from("folders").update({ name: nextName, parent_id: newParentId }).eq("id", editTarget.id);
        if (error) throw error;
      }

      setEditModalOpen(false);
      setEditTarget(null);
      setEditName("");
      setEditMoveFolderId("");

      setStatus("✅ Saved.");
      await refreshAll();
    } catch (e: any) {
      setStatus("Edit error: " + (e?.message ?? "unknown"));
    }
  }

  // ---------------------------
  // Effects
  // ---------------------------
  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshFiles(currentFolderId);
    if (shareModalOpen && shareTarget?.folderId) {
      refreshFolderPermissions(shareTarget.folderId);
    } else {
      refreshFolderPermissions(currentFolderId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId, isAdminOrSupervisor]);

  const folderById = useMemo(() => {
    const map = new Map<string, Folder>();
    for (const f of folders) map.set(f.id, f);
    return map;
  }, [folders]);

  const breadcrumbs = useMemo(() => {
    if (!currentFolderId) return [];
    const chain: Folder[] = [];
    let cursor = folderById.get(currentFolderId);

    while (cursor) {
      chain.unshift(cursor);
      if (!cursor.parent_id) break;
      cursor = folderById.get(cursor.parent_id);
    }

    return chain;
  }, [currentFolderId, folderById]);

  const childFolders = useMemo(() => {
    if (!currentFolderId) return [];
    return folders.filter((f) => f.parent_id === currentFolderId);
  }, [folders, currentFolderId]);

  const currentFolderName =
    currentFolderId && folderById.get(currentFolderId)
      ? rootFolder?.id && currentFolderId === rootFolder.id
        ? "HOME"
        : folderById.get(currentFolderId)!.name
      : "Folder";

  const itemsEmpty = childFolders.length === 0 && files.length === 0;

  // Folder destination options
  const folderMoveOptions = useMemo(() => {
    return folders.slice().sort((a, b) => a.name.localeCompare(b.name));
  }, [folders]);

  function closeShareModal() {
    setShareModalOpen(false);
    setShareTarget(null);
    setShareChecked(new Set());
  }
  function closeDeleteModal() {
    setDeleteModalOpen(false);
    setDeleteTarget(null);
  }
  function closeEditModal() {
    setEditModalOpen(false);
    setEditTarget(null);
    setEditName("");
    setEditMoveFolderId("");
  }

  // Office viewer URL (iframe)
  const officeEmbedUrl = useMemo(() => {
    if (!previewSignedUrl) return "";
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(previewSignedUrl)}`;
  }, [previewSignedUrl]);

  return (
    <main className="stack">
      <div className="row-between">
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="h1">Home</h1>
        </div>
        {status ? <span className="badge badge-pink">{status}</span> : null}
      </div>

      {!sessionEmail ? (
        <div className="card" style={{ maxWidth: 420 }}>
          <div className="stack">
            <div style={{ fontWeight: 800, fontSize: 16 }}>Sign in</div>
            <input className="input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input
              className="input"
              placeholder="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="btn btn-primary" onClick={signIn}>
              Sign in
            </button>

            {/* CHANGED: "Use your assigned account." + setup button */}
            <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <div className="subtle">Use your assigned account.</div>
              <button className="btn" type="button" onClick={openSetupModal}>
                Set up an account
              </button>
            </div>
          </div>

          {/* NEW: Setup modal */}
          {setupOpen ? (
            <div
              role="dialog"
              aria-modal="true"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                zIndex: 200,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
              }}
              onMouseDown={(e) => {
                if (e.currentTarget === e.target) closeSetupModal();
              }}
            >
              <div
                className="card"
                style={{
                  width: "min(560px, 96vw)",
                  borderRadius: 16,
                  padding: 16,
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div className="stack" style={{ gap: 6 }}>
                    <div style={{ fontWeight: 950, fontSize: 16 }}>Set up an account</div>
                    <div className="subtle">
                      {setupStep === "email"
                        ? "Enter the email your admin created for you."
                        : `Setting password for ${setupEmail.trim() || "your email"}`}
                    </div>
                  </div>
                  <button className="btn" onClick={closeSetupModal} disabled={setupLoading || setupSetPassLoading}>
                    Close
                  </button>
                </div>

                <div className="hr" />

                {setupStep === "email" ? (
                  <div className="stack" style={{ gap: 10 }}>
                    <input
                      className="input"
                      placeholder="Email address"
                      value={setupEmail}
                      onChange={(e) => setSetupEmail(e.target.value)}
                      disabled={setupLoading}
                      autoComplete="email"
                    />

                    <div className="row" style={{ justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                      <button className="btn" onClick={closeSetupModal} disabled={setupLoading}>
                        Cancel
                      </button>
                      <button className="btn btn-primary" onClick={() => void runSetupCheck()} disabled={setupLoading}>
                        {setupLoading ? "Checking..." : "Continue"}
                      </button>
                    </div>

                    {setupCheck?.status === "no_password" ? (
                      <div className="subtle" style={{ marginTop: 6 }}>
                        Account found{setupCheck.full_name ? `: ${setupCheck.full_name}` : ""}. You can set a password next.
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="stack" style={{ gap: 10 }}>
                    <input
                      className="input"
                      placeholder="New password (min 8 characters)"
                      type="password"
                      value={setupPass1}
                      onChange={(e) => setSetupPass1(e.target.value)}
                      disabled={setupSetPassLoading}
                      autoComplete="new-password"
                    />
                    <input
                      className="input"
                      placeholder="Confirm password"
                      type="password"
                      value={setupPass2}
                      onChange={(e) => setSetupPass2(e.target.value)}
                      disabled={setupSetPassLoading}
                      autoComplete="new-password"
                    />

                    <div className="row" style={{ justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          if (setupSetPassLoading) return;
                          setSetupStep("email");
                          setSetupCheck(null);
                          setSetupPass1("");
                          setSetupPass2("");
                          setStatus("");
                        }}
                        disabled={setupSetPassLoading}
                      >
                        Back
                      </button>

                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={() => void runSetupSetPassword()}
                        disabled={setupSetPassLoading}
                      >
                        {setupSetPassLoading ? "Setting..." : "Set password & finish"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* ONE MAIN WORKSPACE */}
          <div className="card" style={{ padding: 16 }}>
            {/* Top row: current path (left) + tools (right) */}
            <div className="row-between" style={{ alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
              <div className="stack" style={{ gap: 8, minWidth: 280 }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>Current path</div>

                <div>
                  {breadcrumbs.length === 0 ? (
                    <span className="subtle">—</span>
                  ) : (
                    breadcrumbs.map((f, idx) => {
                      const label = rootFolder?.id && f.id === rootFolder.id ? "HOME" : f.name;
                      return (
                        <span key={f.id}>
                          <button className="link" onClick={() => setCurrentFolderId(f.id)}>
                            {label}
                          </button>
                          {idx < breadcrumbs.length - 1 ? <span className="subtle"> / </span> : null}
                        </span>
                      );
                    })
                  )}
                </div>

                {/* Shared shortcuts inline */}
                <div className="subtle" style={{ marginTop: 2 }}>
                  Shared with me:
                </div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {sharedFolders.length === 0 ? (
                    <span className="subtle">(Nothing shared yet)</span>
                  ) : (
                    sharedFolders.map((f) => (
                      <button
                        key={f.id}
                        className="btn"
                        onClick={() => setCurrentFolderId(f.id)}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 999,
                          border: "1px solid var(--border)",
                          background: "white",
                          fontWeight: 700,
                        }}
                        title="Jump to shared folder"
                      >
                        📁 {f.name}
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="stack" style={{ gap: 10, minWidth: 320, flex: 1 }}>
                {canManageFiles ? (
                  <>
                    <div style={{ fontWeight: 900 }}>Supervisor tools</div>

                    <div className="row" style={{ alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                      <input
                        className="input"
                        placeholder={`New folder inside ${currentFolderName}`}
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        style={{ flex: 1, minWidth: 220 }}
                      />
                      <button className="btn btn-primary" onClick={handleCreateFolder} disabled={!currentFolderId}>
                        Create folder
                      </button>

                      <input
                        className="input"
                        type="file"
                        multiple
                        disabled={uploading || !currentFolderId}
                        onChange={(e) => {
                          handleUploadSelectedFiles(e.target.files);
                          e.currentTarget.value = "";
                        }}
                        style={{ flex: 1, minWidth: 220 }}
                      />
                    </div>
                  </>
                ) : (
                  <div className="subtle"></div>
                )}
              </div>
            </div>

            <div className="hr" style={{ marginTop: 14 }} />

            {/* Items list (folders + files) */}
            <div className="stack" style={{ gap: 10 }}>
              <div className="row-between">
                <div>
                  <div style={{ fontWeight: 950, fontSize: 16 }}>Items</div>
                </div>

                {currentFolderId ? (
                  <button
                    className="btn"
                    onClick={() => openShareModalForFolder(currentFolderId, `Share: ${currentFolderName}`)}
                    disabled={!isAdminOrSupervisor}
                  >
                    Share this folder
                  </button>
                ) : null}
              </div>

              {itemsEmpty ? (
                <div className="subtle">(No folders or files here)</div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {/* Folders */}
                  {childFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="row-between"
                      style={{
                        padding: 10,
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        background: "white",
                      }}
                    >
                      <button
                        className="link"
                        onClick={() => setCurrentFolderId(folder.id)}
                        style={{ fontWeight: 850, textAlign: "left" }}
                        title="Open folder"
                      >
                        📁 {folder.name}
                      </button>

                      <div className="row" style={{ gap: 8 }}>
                        <IconButton
                          title={isAdminOrSupervisor ? "Rename / move folder" : "Only supervisors can edit"}
                          disabled={!isAdminOrSupervisor}
                          onClick={() => openEditModalForFolder(folder)}
                        >
                          ⚙️
                        </IconButton>

                        {isAdminOrSupervisor ? (
                          <IconButton
                            title="Download folder as ZIP"
                            onClick={() => handleDownloadFolderAsZip(folder.id, folder.name)}
                          >
                            ⬇️
                          </IconButton>
                        ) : null}

                        <IconButton
                          title={isAdminOrSupervisor ? "Share folder" : "Only supervisors can share"}
                          disabled={!isAdminOrSupervisor}
                          onClick={() => openShareModalForFolder(folder.id, `Share folder: ${folder.name}`)}
                        >
                          🔗
                        </IconButton>

                        <IconButton
                          title={isAdminOrSupervisor ? "Delete folder" : "Only supervisors can delete"}
                          disabled={!isAdminOrSupervisor}
                          onClick={() => openDeleteConfirm({ type: "folder", id: folder.id, name: folder.name })}
                        >
                          🗑️
                        </IconButton>
                      </div>
                    </div>
                  ))}

                  {/* Files */}
                  {files.map((f) => (
                    <div
                      key={f.id}
                      className="row-between"
                      style={{
                        padding: 10,
                        border: "1px solid var(--border)",
                        borderRadius: 12,
                        background: "white",
                      }}
                    >
                      <div className="stack" style={{ gap: 2 }}>
                        <div style={{ fontWeight: 750 }}>📄 {f.name}</div>
                        <div className="subtle">{(f as any).mime_type ?? ""}</div>
                      </div>

                      <div className="row" style={{ gap: 8 }}>
                        <IconButton title="Preview" onClick={() => openPreview(f)}>
                          👁️
                        </IconButton>

                        <IconButton
                          title={isAdminOrSupervisor ? "Rename / move file" : "Only supervisors can edit"}
                          disabled={!isAdminOrSupervisor}
                          onClick={() => openEditModalForFile(f)}
                        >
                          ⚙️
                        </IconButton>

                        {isAdminOrSupervisor ? (
                          <IconButton title="Download file" onClick={() => handleDownload(f.id)}>
                            ⬇️
                          </IconButton>
                        ) : null}

                        <IconButton
                          title={isAdminOrSupervisor ? "Share (shares containing folder)" : "Only supervisors can share"}
                          disabled={!isAdminOrSupervisor}
                          onClick={() => openShareModalForFile(f)}
                        >
                          🔗
                        </IconButton>

                        <IconButton
                          title={isAdminOrSupervisor ? "Delete file" : "Only supervisors can delete"}
                          disabled={!isAdminOrSupervisor}
                          onClick={() => openDeleteConfirm({ type: "file", id: f.id, name: f.name })}
                        >
                          🗑️
                        </IconButton>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* PREVIEW MODAL (FULLSCREEN) */}
          {previewOpen && previewFile ? (
            <div
              role="dialog"
              aria-modal="true"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                zIndex: 120,
                display: "flex",
                flexDirection: "column",
              }}
              onMouseDown={(e) => {
                if (e.currentTarget === e.target) closePreview();
              }}
            >
              <div
                style={{
                  background: "white",
                  height: "100%",
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div
                  className="row-between"
                  style={{
                    padding: 12,
                    borderBottom: "1px solid var(--border)",
                    gap: 10,
                  }}
                >
                  <div className="stack" style={{ gap: 2 }}>
                    <div style={{ fontWeight: 900 }}>{previewFile.name}</div>
                    <div className="subtle">
                      {previewMode === "office"
                        ? "Office preview"
                        : previewMode === "pdf"
                        ? "PDF preview"
                        : previewMode === "image"
                        ? "Image preview"
                        : previewMode === "text"
                        ? "Text preview"
                        : "Preview"}
                    </div>
                  </div>

                  <button className="btn" onClick={closePreview} title="Close">
                    ✕
                  </button>
                </div>

                <div style={{ flex: 1, minHeight: 0, background: "#111" }}>
                  {previewLoading ? (
                    <div style={{ padding: 14, color: "white" }}>Loading preview…</div>
                  ) : previewMode === "office" ? (
                    previewSignedUrl ? (
                      <iframe
                        src={officeEmbedUrl}
                        style={{ width: "100%", height: "100%", border: 0, background: "white" }}
                        allowFullScreen
                      />
                    ) : (
                      <div style={{ padding: 14, color: "white" }}>No preview URL.</div>
                    )
                  ) : previewMode === "pdf" ? (
                    previewSignedUrl ? (
                      <iframe
                        src={previewSignedUrl}
                        style={{ width: "100%", height: "100%", border: 0, background: "white" }}
                      />
                    ) : (
                      <div style={{ padding: 14, color: "white" }}>PDF preview unavailable.</div>
                    )
                  ) : previewMode === "image" ? (
                    previewSignedUrl ? (
                      <div style={{ height: "100%", width: "100%", display: "flex", justifyContent: "center", alignItems: "center" }}>
                        <img
                          src={previewSignedUrl}
                          alt={previewFile.name}
                          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "white" }}
                        />
                      </div>
                    ) : (
                      <div style={{ padding: 14, color: "white" }}>Image preview unavailable.</div>
                    )
                  ) : previewMode === "text" ? (
                    previewSignedUrl ? (
                      <iframe
                        src={previewSignedUrl}
                        style={{ width: "100%", height: "100%", border: 0, background: "white" }}
                      />
                    ) : (
                      <div style={{ padding: 14, color: "white" }}>Text preview unavailable.</div>
                    )
                  ) : (
                    <div style={{ padding: 14, color: "white" }}>
                      No in-app preview for this file type.
                      <div className="subtle" style={{ marginTop: 10, color: "rgba(255,255,255,0.8)" }}>
                        {isAdminOrSupervisor
                          ? "You can download it to view."
                          : "Ask a supervisor if you need this file."}
                      </div>

                      {isAdminOrSupervisor ? (
                        <div style={{ marginTop: 10 }}>
                          <button className="btn btn-primary" onClick={() => handleDownload(previewFile.id)}>
                            Download
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {/* SHARE MODAL */}
          {shareModalOpen && shareTarget ? (
            <div
              role="dialog"
              aria-modal="true"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                zIndex: 80,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
              }}
              onMouseDown={(e) => {
                if (e.currentTarget === e.target) closeShareModal();
              }}
            >
              <div
                className="card"
                style={{
                  width: "min(900px, 96vw)",
                  maxHeight: "88vh",
                  overflow: "auto",
                  borderRadius: 16,
                  padding: 16,
                }}
              >
                <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div className="stack" style={{ gap: 6 }}>
                    <div style={{ fontWeight: 950, fontSize: 16 }}>Share</div>
                    <div className="subtle">{shareTarget.label}</div>
                  </div>

                  <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                    <button className="btn" onClick={closeShareModal}>
                      Close
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={shareToSelectedTeachers}
                      disabled={!isAdminOrSupervisor || shareChecked.size === 0}
                      title={shareChecked.size === 0 ? "Select at least 1 teacher" : "Share to selected teachers"}
                    >
                      Share ({shareChecked.size})
                    </button>
                  </div>
                </div>

                <div className="hr" />

                <div className="grid-2">
                  {/* Teacher checklist */}
                  <div className="card" style={{ borderRadius: 12 }}>
                    <div style={{ fontWeight: 900 }}>Active teachers</div>
                    <div className="hr" />

                    {teachers.length === 0 ? (
                      <div className="subtle">(No active teachers)</div>
                    ) : (
                      <div className="stack" style={{ gap: 8 }}>
                        {teachers.map((t) => {
                          const checked = shareChecked.has(t.id);
                          return (
                            <label
                              key={t.id}
                              className="row"
                              style={{
                                gap: 10,
                                padding: 10,
                                border: "1px solid var(--border)",
                                borderRadius: 12,
                                background: checked ? "rgba(230,23,141,0.06)" : "white",
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const next = new Set(shareChecked);
                                  if (e.target.checked) next.add(t.id);
                                  else next.delete(t.id);
                                  setShareChecked(next);
                                }}
                              />
                              <div style={{ fontWeight: 750 }}>{labelForTeacher(t)}</div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Folder access table (direct grants) */}
                  <div className="card" style={{ borderRadius: 12 }}>
                    <div className="row-between">
                      <div>
                        <div style={{ fontWeight: 900 }}>Folder Access (direct grants)</div>
                      </div>
                      <button className="btn" onClick={() => refreshFolderPermissions(shareTarget.folderId)} disabled={folderPermsLoading}>
                        Refresh
                      </button>
                    </div>

                    <div className="hr" />

                    {folderPermsLoading ? (
                      <div className="subtle">Loading…</div>
                    ) : folderPerms.length === 0 ? (
                      <div className="subtle">(No direct shares on this folder)</div>
                    ) : (
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Email</th>
                            <th>Access</th>
                            <th>Inherit</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {folderPerms.map((p) => (
                            <tr key={p.permission_id}>
                              <td>{p.email ?? p.principal_user_id}</td>
                              <td>
                                <span className="badge badge-pink">{p.access}</span>
                              </td>
                              <td>{p.inherit ? "true" : "false"}</td>
                              <td>
                                <button className="btn" onClick={() => revokePermission(p.permission_id)}>
                                  Revoke
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* DELETE CONFIRM MODAL */}
          {deleteModalOpen && deleteTarget ? (
            <div
              role="dialog"
              aria-modal="true"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                zIndex: 90,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
              }}
              onMouseDown={(e) => {
                if (e.currentTarget === e.target) closeDeleteModal();
              }}
            >
              <div className="card" style={{ width: "min(560px, 96vw)", borderRadius: 16, padding: 16 }}>
                <div style={{ fontWeight: 950, fontSize: 16 }}>Confirm delete</div>
                <div className="subtle" style={{ marginTop: 8 }}>
                  Are you sure you want to delete <strong>"{deleteTarget.name}"</strong>?
                  {deleteTarget.type === "folder" ? (
                    <div className="subtle" style={{ marginTop: 6 }}>
                      This will delete the folder and its contents (subfolders + files).
                    </div>
                  ) : null}
                </div>

                <div className="hr" />

                <div className="row" style={{ justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                  <button className="btn" onClick={closeDeleteModal}>
                    Cancel
                  </button>
                  <button className="btn btn-primary" onClick={handleConfirmDelete}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* EDIT (RENAME/MOVE) MODAL */}
          {editModalOpen && editTarget ? (
            <div
              role="dialog"
              aria-modal="true"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                zIndex: 90,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
              }}
              onMouseDown={(e) => {
                if (e.currentTarget === e.target) closeEditModal();
              }}
            >
              <div
                className="card"
                style={{
                  width: "min(700px, 96vw)",
                  maxHeight: "88vh",
                  overflow: "auto",
                  borderRadius: 16,
                  padding: 16,
                }}
              >
                <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div className="stack" style={{ gap: 6 }}>
                    <div style={{ fontWeight: 950, fontSize: 16 }}>
                      Edit {editTarget.type === "folder" ? "folder" : "file"}
                    </div>
                  </div>
                  <button className="btn" onClick={closeEditModal}>
                    Close
                  </button>
                </div>

                <div className="hr" />

                <div className="stack" style={{ gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Name</div>
                    <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </div>

                  <div>
                    <div style={{ fontWeight: 900, marginBottom: 6 }}>Move to</div>

                    <select className="select" value={editMoveFolderId} onChange={(e) => setEditMoveFolderId(e.target.value)} style={{ width: "100%" }}>
                      {folderMoveOptions.map((f) => {
                        if (editTarget.type === "folder") {
                          const selfId = editTarget.id;
                          if (f.id === selfId) return null;
                          if (isDescendantFolder(f.id, selfId)) return null;
                        }
                        return (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        );
                      })}
                    </select>

                    {editTarget.type === "folder" ? (
                      <div className="subtle" style={{ marginTop: 8 }}>
                        Moving a folder moves everything inside it automatically.
                      </div>
                    ) : null}
                  </div>

                  <div className="row" style={{ justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                    <button className="btn" onClick={closeEditModal}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={saveEditChanges} disabled={!editName.trim()}>
                      Save
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
