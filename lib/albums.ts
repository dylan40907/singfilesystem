import { supabase } from "./supabaseClient";

/**
 * Chat albums — a shared photo/video roll inside a conversation.
 *
 * Everyone in the chat can add to an album. Creating, renaming, deleting and
 * downloading the whole thing is for supervisors and up, which the database
 * enforces through chat_can_manage_members(); `canManage` below asks the same
 * question so the UI can hide what it would refuse anyway.
 */

const BUCKET = "chat-attachments";

export type Album = {
  id: string;
  conversation_id: string;
  name: string;
  created_by: string | null;
  created_at: string;
};

export type AlbumItem = {
  id: string;
  album_id: string;
  path: string;
  name: string;
  mime: string | null;
  size: number | null;
  kind: "image" | "video";
  uploaded_by: string | null;
  created_at: string;
};

export type AlbumWithCount = Album & { item_count: number; cover_path: string | null };

/** Can the signed-in user create, rename, delete or download albums here? */
export async function canManageAlbums(conversationId: string): Promise<boolean> {
  const { data } = await supabase.rpc("chat_can_manage_members", { p_conversation: conversationId });
  return data === true;
}

export async function fetchAlbums(conversationId: string): Promise<AlbumWithCount[]> {
  const { data, error } = await supabase
    .from("chat_albums")
    .select("*, chat_album_items(id, path, created_at)")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  return ((data ?? []) as (Album & { chat_album_items: { id: string; path: string; created_at: string }[] })[])
    .map((a) => {
      const items = [...(a.chat_album_items ?? [])].sort((x, y) => y.created_at.localeCompare(x.created_at));
      return {
        id: a.id, conversation_id: a.conversation_id, name: a.name,
        created_by: a.created_by, created_at: a.created_at,
        item_count: items.length,
        cover_path: items[0]?.path ?? null,
      };
    });
}

export async function fetchAlbumItems(albumId: string): Promise<AlbumItem[]> {
  const { data, error } = await supabase
    .from("chat_album_items")
    .select("*")
    .eq("album_id", albumId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as AlbumItem[]) ?? [];
}

export async function createAlbum(conversationId: string, name: string): Promise<Album> {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("chat_albums")
    .insert({ conversation_id: conversationId, name: name.trim(), created_by: me.user?.id ?? null })
    .select()
    .single();
  if (error) throw error;
  return data as Album;
}

export async function renameAlbum(albumId: string, name: string): Promise<void> {
  const { error } = await supabase.from("chat_albums").update({ name: name.trim() }).eq("id", albumId);
  if (error) throw error;
}

/**
 * Delete an album and everything in it. Rows go first — if the storage cleanup
 * fails we're left with orphaned files rather than an album whose photos have
 * silently vanished.
 */
export async function deleteAlbum(albumId: string): Promise<void> {
  const items = await fetchAlbumItems(albumId);
  const { error } = await supabase.from("chat_albums").delete().eq("id", albumId);
  if (error) throw error;
  if (items.length) await supabase.storage.from(BUCKET).remove(items.map((i) => i.path));
}

export async function deleteAlbumItem(item: AlbumItem): Promise<void> {
  const { error } = await supabase.from("chat_album_items").delete().eq("id", item.id);
  if (error) throw error;
  await supabase.storage.from(BUCKET).remove([item.path]);
}

/** Only images and videos belong in an album. */
export function albumKindOf(mime: string, filename: string): "image" | "video" | null {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp"].includes(ext)) return "image";
  if (["mp4", "mov", "m4v", "webm", "avi", "mkv"].includes(ext)) return "video";
  return null;
}

export async function uploadToAlbum(
  conversationId: string,
  albumId: string,
  file: File
): Promise<AlbumItem> {
  const kind = albumKindOf(file.type, file.name);
  if (!kind) throw new Error(`${file.name} isn't a photo or a video.`);

  const safe = (file.name || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-100);
  // First folder must stay the conversation id — that's what the bucket's
  // policies read to decide who may touch the file.
  const path = `${conversationId}/albums/${albumId}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (upErr) throw upErr;

  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("chat_album_items")
    .insert({
      album_id: albumId, path, name: file.name || safe,
      mime: file.type || null, size: file.size ?? null, kind,
      uploaded_by: me.user?.id ?? null,
    })
    .select()
    .single();
  if (error) {
    // Don't leave a file nobody can see behind.
    await supabase.storage.from(BUCKET).remove([path]);
    throw error;
  }
  return data as AlbumItem;
}

export async function albumItemUrl(path: string, seconds = 3600): Promise<string | null> {
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}

/** Signed URLs for a whole album in one round trip. */
export async function albumItemUrls(paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, seconds);
  const out: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) out[row.path] = row.signedUrl;
  }
  return out;
}

/**
 * Download the album as a zip. The /api/zip route streams it, fetching each
 * signed URL server-side, so the browser never has to hold the whole thing.
 */
export async function downloadAlbumZip(album: Album, items: AlbumItem[]): Promise<void> {
  if (items.length === 0) throw new Error("This album is empty.");
  const urls = await albumItemUrls(items.map((i) => i.path));

  // Two photos can share a filename; number them so neither is lost in the zip.
  const used = new Set<string>();
  const files = items
    .filter((i) => urls[i.path])
    .map((i) => {
      let name = i.name.replace(/[\\/:*?"<>|]+/g, "_");
      if (used.has(name.toLowerCase())) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        let n = 2;
        while (used.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
        name = `${stem} (${n})${ext}`;
      }
      used.add(name.toLowerCase());
      return { url: urls[i.path], path: name };
    });

  const { data: sess } = await supabase.auth.getSession();
  const res = await fetch("/api/zip", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sess.session?.access_token ?? ""}`,
    },
    body: JSON.stringify({ zipName: album.name || "album", files }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? "Download failed.");
  }

  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = `${(album.name || "album").replace(/[\\/:*?"<>|]+/g, "_")}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}
