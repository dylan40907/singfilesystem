"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Album,
  AlbumItem,
  AlbumWithCount,
  albumItemUrls,
  albumKindOf,
  createAlbum,
  deleteAlbum,
  deleteAlbumItem,
  downloadAlbumZip,
  fetchAlbumItems,
  fetchAlbums,
  renameAlbum,
  uploadToAlbum,
} from "@/lib/albums";
import { useDialog } from "@/components/ui/useDialog";
import { useEscapeKey } from "@/components/ui/useEscapeKey";

/**
 * Albums for one conversation — a shared photo/video roll, like Line's.
 *
 * Everyone in the chat can add to an album. Creating, renaming, deleting and
 * downloading the lot is for supervisors and up; `canManage` mirrors what the
 * database will allow, so nothing on screen is a button that would fail.
 */
export default function ChatAlbumsModal({
  conversationId,
  conversationName,
  canManage,
  onClose,
}: {
  conversationId: string;
  conversationName: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const { confirm, prompt, alert, modal: dialogModal } = useDialog();
  const [albums, setAlbums] = useState<AlbumWithCount[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Album | null>(null);
  const [items, setItems] = useState<AlbumItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [lightbox, setLightbox] = useState<AlbumItem | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Escape closes the open album first, then the modal — one step at a time.
  useEscapeKey(() => {
    if (lightbox) setLightbox(null);
    else if (open) setOpen(null);
    else onClose();
  });

  const loadAlbums = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchAlbums(conversationId);
      setAlbums(list);
      const paths = list.map((a) => a.cover_path).filter(Boolean) as string[];
      setCovers(await albumItemUrls(paths));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  const loadItems = useCallback(async (albumId: string) => {
    setLoading(true);
    try {
      const list = await fetchAlbumItems(albumId);
      setItems(list);
      setUrls(await albumItemUrls(list.map((i) => i.path)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadAlbums(); }, [loadAlbums]);
  useEffect(() => { if (open) void loadItems(open.id); }, [open, loadItems]);

  async function onNewAlbum() {
    const name = await prompt("Name this album", { title: "New album", confirmLabel: "Create" });
    if (!name?.trim()) return;
    setBusy("new"); setErr("");
    try {
      const a = await createAlbum(conversationId, name);
      await loadAlbums();
      setOpen(a);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  async function onRename() {
    if (!open) return;
    const name = await prompt("Rename album", { title: open.name, defaultValue: open.name, confirmLabel: "Save" });
    if (!name?.trim() || name.trim() === open.name) return;
    setBusy("rename");
    try {
      await renameAlbum(open.id, name);
      setOpen({ ...open, name: name.trim() });
      await loadAlbums();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  async function onDeleteAlbum() {
    if (!open) return;
    const ok = await confirm(
      `Delete “${open.name}” and all ${items.length} item${items.length === 1 ? "" : "s"} in it? This can't be undone.`,
      { title: "Delete album", confirmLabel: "Delete", danger: true }
    );
    if (!ok) return;
    setBusy("delete");
    try {
      await deleteAlbum(open.id);
      setOpen(null);
      await loadAlbums();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  async function onUpload(files: FileList | null) {
    if (!open || !files?.length) return;
    const list = Array.from(files);
    const bad = list.filter((f) => !albumKindOf(f.type, f.name));
    if (bad.length) {
      await alert(`Albums hold photos and videos only. Skipped: ${bad.map((f) => f.name).join(", ")}`, { title: "Not added" });
    }
    const good = list.filter((f) => albumKindOf(f.type, f.name));
    if (!good.length) return;

    setErr("");
    for (let i = 0; i < good.length; i++) {
      setBusy(`upload:${i + 1}/${good.length}`);
      try {
        await uploadToAlbum(conversationId, open.id, good[i]);
      } catch (e) {
        setErr(`${good[i].name}: ${(e as Error).message}`);
        break;
      }
    }
    setBusy("");
    await loadItems(open.id);
    await loadAlbums();
  }

  async function onDeleteItem(item: AlbumItem) {
    const ok = await confirm(`Remove ${item.name} from this album?`, {
      title: "Remove item", confirmLabel: "Remove", danger: true,
    });
    if (!ok) return;
    setBusy("item");
    try {
      await deleteAlbumItem(item);
      if (open) { await loadItems(open.id); await loadAlbums(); }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  async function onDownload() {
    if (!open) return;
    setBusy("zip"); setErr("");
    try {
      await downloadAlbumZip(open, items);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  return (
    <div
      onMouseDown={(e) => { if (e.currentTarget === e.target) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      {dialogModal}
      <div
        className="card"
        style={{ width: "min(880px, 96vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", gap: 12 }}
      >
        {/* Header */}
        <div className="row-between" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 900, fontSize: 17 }}>
              {open ? open.name : "Albums"}
            </div>
            <div className="subtle" style={{ fontSize: 12 }}>
              {open ? `${items.length} item${items.length === 1 ? "" : "s"}` : conversationName}
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {open ? (
              <>
                <button className="btn" onClick={() => setOpen(null)}>← Albums</button>
                <label className="btn btn-primary" style={{ cursor: busy ? "default" : "pointer" }}>
                  {busy.startsWith("upload") ? `Uploading ${busy.split(":")[1]}…` : "+ Add photos / videos"}
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files; e.target.value = ""; void onUpload(f); }}
                  />
                </label>
                {canManage && (
                  <>
                    <button className="btn" onClick={() => void onDownload()} disabled={busy === "zip" || items.length === 0}>
                      {busy === "zip" ? "Zipping…" : "⤓ Download all"}
                    </button>
                    <button className="btn" onClick={() => void onRename()}>✎ Rename</button>
                    <button className="btn" style={{ color: "#b91c1c" }} onClick={() => void onDeleteAlbum()}>Delete album</button>
                  </>
                )}
              </>
            ) : (
              <>
                {canManage && (
                  <button className="btn btn-primary" onClick={() => void onNewAlbum()} disabled={busy === "new"}>
                    + New album
                  </button>
                )}
                <button className="btn" onClick={onClose}>Close</button>
              </>
            )}
          </div>
        </div>

        {err && (
          <div style={{ padding: "8px 12px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13 }}>
            {err}
          </div>
        )}

        {/* Body */}
        <div style={{ overflowY: "auto", minHeight: 200 }}>
          {loading ? (
            <div className="subtle" style={{ padding: 20 }}>Loading…</div>
          ) : open ? (
            items.length === 0 ? (
              <div className="subtle" style={{ padding: 20, fontSize: 14 }}>
                Nothing here yet. Add the first photos or videos.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
                {items.map((it) => (
                  <div key={it.id} style={{ position: "relative" }}>
                    <button
                      onClick={() => setLightbox(it)}
                      title={it.name}
                      style={{
                        width: "100%", aspectRatio: "1 / 1", padding: 0, overflow: "hidden",
                        borderRadius: 10, border: "1px solid #e5e7eb", background: "#f3f4f6", cursor: "pointer",
                      }}
                    >
                      {urls[it.path] && it.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={urls[it.path]} alt={it.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : urls[it.path] && it.kind === "video" ? (
                        <video src={urls[it.path]} muted playsInline preload="metadata"
                          style={{ width: "100%", height: "100%", objectFit: "cover", background: "#000" }} />
                      ) : (
                        <span style={{ fontSize: 26 }}>{it.kind === "video" ? "🎬" : "🖼"}</span>
                      )}
                    </button>
                    {it.kind === "video" && (
                      <span style={{
                        position: "absolute", left: 6, bottom: 6, fontSize: 11, fontWeight: 800,
                        color: "white", background: "rgba(0,0,0,0.55)", borderRadius: 6, padding: "1px 6px",
                      }}>▶</span>
                    )}
                    {canManage && (
                      <button
                        onClick={() => void onDeleteItem(it)}
                        title="Remove"
                        style={{
                          position: "absolute", top: 6, right: 6, width: 24, height: 24, borderRadius: 12,
                          border: "none", background: "rgba(0,0,0,0.55)", color: "white",
                          fontSize: 13, lineHeight: 1, cursor: "pointer",
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : albums.length === 0 ? (
            <div className="subtle" style={{ padding: 20, fontSize: 14 }}>
              {canManage
                ? "No albums yet. Create one to start collecting photos and videos from this chat."
                : "No albums yet. A supervisor can create one."}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
              {albums.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setOpen(a)}
                  style={{
                    padding: 0, border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden",
                    background: "white", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <div style={{ width: "100%", aspectRatio: "4 / 3", background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {a.cover_path && covers[a.cover_path] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={covers[a.cover_path]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <span style={{ fontSize: 30 }}>📷</span>
                    )}
                  </div>
                  <div style={{ padding: "8px 10px" }}>
                    <div style={{ fontWeight: 800, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.name}
                    </div>
                    <div className="subtle" style={{ fontSize: 12 }}>
                      {a.item_count} item{a.item_count === 1 ? "" : "s"}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {lightbox && urls[lightbox.path] && (
        <div
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.92)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
        >
          {lightbox.kind === "video" ? (
            <video src={urls[lightbox.path]} controls autoPlay
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8, background: "#000" }} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={urls[lightbox.path]} alt={lightbox.name}
              style={{ maxWidth: "92vw", maxHeight: "86vh", borderRadius: 8 }} />
          )}
        </div>
      )}
    </div>
  );
}
