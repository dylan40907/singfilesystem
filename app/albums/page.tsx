"use client";

/**
 * Albums — the school's shared photo and video library.
 *
 * Every active account sees every album and can add to it. Creating, renaming,
 * deleting and downloading is for supervisors and up; `canManage` mirrors what
 * the database will allow, so nothing on screen is a button that would fail.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { useDialog } from "@/components/ui/useDialog";
import { useEscapeKey } from "@/components/ui/useEscapeKey";
import {
  Album,
  AlbumItem,
  AlbumWithCount,
  albumItemUrls,
  albumKindOf,
  canManageAlbums,
  createAlbum,
  deleteAlbum,
  deleteAlbumItem,
  downloadAlbumZip,
  fetchAlbumItems,
  fetchAlbums,
  renameAlbum,
  uploadToAlbum,
} from "@/lib/albums";

export default function AlbumsPage() {
  const router = useRouter();
  const { confirm, prompt, alert, modal: dialogModal } = useDialog();

  const [authChecked, setAuthChecked] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [albums, setAlbums] = useState<AlbumWithCount[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Album | null>(null);
  const [items, setItems] = useState<AlbumItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [lightbox, setLightbox] = useState<AlbumItem | null>(null);

  useEscapeKey(() => {
    if (lightbox) setLightbox(null);
    else if (open) setOpen(null);
  }, !!lightbox || !!open);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session?.user) { router.replace("/"); return; }
      setCanManage(await canManageAlbums());
      setAuthChecked(true);
    })();
  }, [router]);

  const loadAlbums = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchAlbums();
      setAlbums(list);
      setCovers(await albumItemUrls(list.map((a) => a.cover_path).filter(Boolean) as string[]));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

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

  useEffect(() => { if (authChecked) void loadAlbums(); }, [authChecked, loadAlbums]);
  useEffect(() => { if (open) void loadItems(open.id); }, [open, loadItems]);

  async function onNewAlbum() {
    const name = await prompt("Name this album", {
      title: "New album", confirmLabel: "Create", placeholder: "Spring Field Trip",
    });
    if (!name) return;
    setBusy("new"); setErr("");
    try {
      const a = await createAlbum(name);
      await loadAlbums();
      setOpen(a);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  async function onRename() {
    if (!open) return;
    const name = await prompt("Rename album", { title: open.name, defaultValue: open.name, confirmLabel: "Save" });
    if (!name || name === open.name) return;
    try {
      await renameAlbum(open.id, name);
      setOpen({ ...open, name });
      await loadAlbums();
    } catch (e) { setErr((e as Error).message); }
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
        await uploadToAlbum(open.id, good[i]);
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
    try {
      await deleteAlbumItem(item);
      setLightbox(null);
      if (open) { await loadItems(open.id); await loadAlbums(); }
    } catch (e) { setErr((e as Error).message); }
  }

  async function onDownload() {
    if (!open) return;
    setBusy("zip"); setErr("");
    try {
      await downloadAlbumZip(open, items);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  }

  if (!authChecked) return null;

  return (
    <main className="stack">
      {dialogModal}

      <div className="row-between" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="h1" style={{ margin: 0 }}>{open ? open.name : "Albums"}</h1>
          <div className="subtle" style={{ fontSize: 13, marginTop: 2 }}>
            {open
              ? `${items.length} item${items.length === 1 ? "" : "s"}`
              : "Shared photos and videos. Everyone can add; supervisors manage."}
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {open ? (
            <>
              <button className="btn" onClick={() => setOpen(null)}>← All albums</button>
              <label className="btn btn-primary" style={{ cursor: busy ? "default" : "pointer" }}>
                {busy.startsWith("upload") ? `Uploading ${busy.split(":")[1]}…` : "+ Add photos / videos"}
                <input
                  type="file" multiple accept="image/*,video/*" style={{ display: "none" }}
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
          ) : canManage ? (
            <button className="btn btn-primary" onClick={() => void onNewAlbum()} disabled={busy === "new"}>
              + New album
            </button>
          ) : null}
        </div>
      </div>

      {err && (
        <div style={{ padding: "10px 14px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13 }}>
          {err}
        </div>
      )}

      {loading ? (
        <div className="subtle" style={{ padding: 24 }}>Loading…</div>
      ) : open ? (
        items.length === 0 ? (
          <div className="card subtle" style={{ fontSize: 14 }}>
            Nothing here yet. Add the first photos or videos.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
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
        <div className="card subtle" style={{ fontSize: 14 }}>
          {canManage
            ? "No albums yet. Create one to start collecting photos and videos."
            : "No albums yet. A supervisor can create one, then you can add photos and videos to it."}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 14 }}>
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
              <div style={{ padding: "9px 11px" }}>
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
    </main>
  );
}
