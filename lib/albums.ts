import { supabase } from "./supabaseClient";

/**
 * Albums — a shared photo/video library for the whole school.
 *
 * Everyone with an active account sees every album and can add to it. Creating,
 * renaming, deleting and downloading is for supervisors and up, which the
 * database enforces through can_manage_albums(); `canManageAlbums` asks the same
 * question so the UI only offers what will actually work.
 */

const BUCKET = "albums";

/**
 * Files live in R2, reached through the /api/r2/media-* routes.
 *
 * Older items still carry a Supabase Storage key (no "albums/" prefix) until
 * the migration script has copied them, so reads fall back to Supabase for
 * those. Once `scripts/migrate-storage-to-r2.mjs --verify` reports nothing
 * missing, the fallback is dead code and can go.
 */
function isR2Key(path: string): boolean {
  return path.startsWith("albums/");
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${data.session?.access_token ?? ""}`,
  };
}

export type Album = {
  id: string;
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

export async function canManageAlbums(): Promise<boolean> {
  const { data } = await supabase.rpc("can_manage_albums");
  return data === true;
}

export async function fetchAlbums(): Promise<AlbumWithCount[]> {
  const { data, error } = await supabase
    .from("albums")
    .select("*, album_items(id, path, created_at)")
    .order("created_at", { ascending: false });
  if (error) throw error;

  return ((data ?? []) as (Album & { album_items: { id: string; path: string; created_at: string }[] })[])
    .map((a) => {
      const items = [...(a.album_items ?? [])].sort((x, y) => y.created_at.localeCompare(x.created_at));
      return {
        id: a.id, name: a.name, created_by: a.created_by, created_at: a.created_at,
        item_count: items.length,
        cover_path: items[0]?.path ?? null,
      };
    });
}

export async function fetchAlbumItems(albumId: string): Promise<AlbumItem[]> {
  const { data, error } = await supabase
    .from("album_items")
    .select("*")
    .eq("album_id", albumId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as AlbumItem[]) ?? [];
}

export async function createAlbum(name: string): Promise<Album> {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("albums")
    .insert({ name: name.trim(), created_by: me.user?.id ?? null })
    .select()
    .single();
  if (error) throw error;
  return data as Album;
}

export async function renameAlbum(albumId: string, name: string): Promise<void> {
  const { error } = await supabase.from("albums").update({ name: name.trim() }).eq("id", albumId);
  if (error) throw error;
}

/**
 * Delete an album and everything in it. Rows go first — if the storage cleanup
 * fails we're left with orphaned files rather than an album whose photos have
 * silently vanished.
 */
export async function deleteAlbum(albumId: string): Promise<void> {
  const items = await fetchAlbumItems(albumId);
  const { error } = await supabase.from("albums").delete().eq("id", albumId);
  if (error) throw error;
  if (items.length) await removeObjects(items.map((i) => i.path));
}

export async function deleteAlbumItem(item: AlbumItem): Promise<void> {
  const { error } = await supabase.from("album_items").delete().eq("id", item.id);
  if (error) throw error;
  await removeObjects([item.path]);
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

export async function uploadToAlbum(albumId: string, file: File): Promise<AlbumItem> {
  const kind = albumKindOf(file.type, file.name);
  if (!kind) throw new Error(`${file.name} isn't a photo or a video.`);

  // Presign, then PUT straight to R2 — the file never passes through our server.
  const presign = await fetch("/api/r2/media-presign", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      scope: "album",
      group: albumId,
      filename: file.name || "file",
      contentType: file.type || "application/octet-stream",
    }),
  });
  const presigned = await presign.json();
  if (!presign.ok) throw new Error(presigned?.error ?? "Could not start the upload.");

  const put = await fetch(presigned.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
  const path: string = presigned.objectKey;

  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("album_items")
    .insert({
      album_id: albumId, path, name: file.name || "file",
      mime: file.type || null, size: file.size ?? null, kind,
      uploaded_by: me.user?.id ?? null,
    })
    .select()
    .single();
  if (error) {
    // Don't leave a file nobody can see behind.
    await removeObjects([path]);
    throw error;
  }
  return data as AlbumItem;
}

export async function albumItemUrl(path: string, seconds = 3600): Promise<string | null> {
  const urls = await albumItemUrls([path], seconds);
  return urls[path] ?? null;
}

/**
 * Signed URLs for a whole album in one round trip.
 *
 * Split by where each object actually is: R2 for anything migrated, Supabase
 * for the rest. Both are signed in a single call to their respective service,
 * so an album grid still costs two requests at most.
 */
export async function albumItemUrls(paths: string[], seconds = 3600): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const out: Record<string, string> = {};

  const r2Keys = paths.filter(isR2Key);
  const legacy = paths.filter((p) => !isR2Key(p));

  if (r2Keys.length) {
    const res = await fetch("/api/r2/media-urls", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ keys: r2Keys, expiresIn: seconds }),
    });
    if (res.ok) Object.assign(out, ((await res.json())?.urls ?? {}) as Record<string, string>);
  }

  if (legacy.length) {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(legacy, seconds);
    for (const row of data ?? []) {
      if (row.path && row.signedUrl) out[row.path] = row.signedUrl;
    }
  }

  return out;
}

/** Delete objects from wherever they live. */
async function removeObjects(paths: string[]): Promise<void> {
  const r2Keys = paths.filter(isR2Key);
  const legacy = paths.filter((p) => !isR2Key(p));

  if (r2Keys.length) {
    await fetch("/api/r2/media-delete", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ keys: r2Keys }),
    });
  }
  if (legacy.length) await supabase.storage.from(BUCKET).remove(legacy);
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
