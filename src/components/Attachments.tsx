import { memo, useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, type Attachment, type Card, type ClipAttachment, type ImageAttachment } from "../api";
import type { Workspace } from "../state/workspace";
import { Layer } from "../ui/Layer";
import { asUrl, useMediaUrl } from "../util/media";
import { IconClip, IconClose } from "./Icons";

const STRIP_MAX = 5;

export const isImage = (a: Attachment): a is ImageAttachment => a.type === "image";
export const isClip = (a: Attachment): a is ClipAttachment => a.type === "clip";

/** The cover is the first image; the strip shows everything else. */
function splitAttachments(list: Attachment[]) {
  const cover = list.find(isImage) ?? null;
  const rest = list.filter((a) => a !== cover);
  return { cover, rest };
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Image files from a drop or paste (all of them, in order). */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const it of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const f = it instanceof File ? it : it.kind === "file" ? it.getAsFile() : null;
    if (f && f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

/** A link dropped or pasted (uri-list first, then plain text that is just a URL). */
export function droppedUrl(dt: DataTransfer | null): string | null {
  if (!dt) return null;
  const list = dt.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  return asUrl(list) ?? asUrl(dt.getData("text/plain"));
}

// ===================================================================================== editor

export function AttachmentsEditor({ card, ws }: { card: Card; ws: Workspace }) {
  const list = card.attachments;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [clipOpen, setClipOpen] = useState(false);
  const [clipUrl, setClipUrl] = useState("");
  const [fetching, setFetching] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const coverId = list.find(isImage)?.id;

  const set = (next: Attachment[]) => void ws.setAttachments(card.id, next);
  const remove = (id: string) => set(list.filter((a) => a.id !== id));
  const makeCover = (id: string) => {
    const a = list.find((x) => x.id === id);
    if (a) set([a, ...list.filter((x) => x.id !== id)]);
  };
  const caption = (id: string, text: string) => {
    const t = text.trim();
    set(list.map((a) => (a.id === id ? ({ ...a, caption: t || undefined } as Attachment) : a)));
  };
  const addClip = async (raw: string) => {
    const url = asUrl(raw) ?? asUrl(`https://${raw.trim()}`);
    if (!url) return;
    setFetching((f) => [...f, url]);
    setClipUrl("");
    setClipOpen(false);
    await ws.addClip(card.id, url);
    setFetching((f) => f.filter((u) => u !== url));
  };

  const onDrop = (e: DragEvent, targetId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragId) {
      const from = list.findIndex((a) => a.id === dragId);
      const moving = list[from];
      const rest = list.filter((a) => a.id !== dragId);
      let to = targetId ? rest.findIndex((a) => a.id === targetId) : rest.length;
      if (to < 0) to = rest.length;
      // Dropping on a later item puts it after that item.
      if (targetId && list.findIndex((a) => a.id === targetId) > from) to += 1;
      const next = [...rest.slice(0, to), moving, ...rest.slice(to)];
      if (next.some((a, i) => a.id !== list[i].id)) set(next);
    } else {
      const files = imageFiles(e.dataTransfer.files);
      if (files.length) void ws.addImages(card.id, files);
      else {
        const url = droppedUrl(e.dataTransfer);
        if (url) void addClip(url);
      }
    }
    setDragId(null);
    setOverId(null);
  };

  return (
    <div className="editor-row" onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={(e) => onDrop(e, null)}>
      <div className="editor-row-head">
        <span className="side-label">Attachments</span>
        <div className="att-add">
          <button type="button" className="chip" onClick={() => fileRef.current?.click()}>+ Image</button>
          <button type="button" className="chip" aria-expanded={clipOpen} onClick={() => setClipOpen((v) => !v)}>+ Web clip</button>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = imageFiles(e.target.files);
          e.target.value = "";
          if (files.length) void ws.addImages(card.id, files);
        }}
      />
      {clipOpen && (
        <form
          className="att-clip-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addClip(clipUrl);
          }}
        >
          <input className="name-input" autoFocus value={clipUrl} onChange={(e) => setClipUrl(e.target.value)} placeholder="https://…" aria-label="Web clip URL" />
          <button type="submit" className="btn primary" disabled={!clipUrl.trim()}>Add</button>
        </form>
      )}
      {list.length === 0 && fetching.length === 0 ? (
        <p className="helper">Paste or drop images and links here. The first image is the card's cover.</p>
      ) : (
        <div className="att-grid">
          {list.map((a) => (
            <div
              key={a.id}
              className={"att-tile" + (a.type === "clip" ? " clip" : "") + (dragId === a.id ? " dragging" : "") + (overId === a.id && dragId !== a.id ? " over" : "")}
              draggable
              onDragStart={(e) => {
                setDragId(a.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("application/x-dreamer-att", a.id);
              }}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); if (dragId) setOverId(a.id); }}
              onDrop={(e) => onDrop(e, a.id)}
            >
              {isImage(a) ? <EditorImageThumb slug={ws.active} att={a} /> : <EditorClipRow slug={ws.active} att={a} onRefresh={() => ws.refreshClip(card.id, a.id)} />}
              <div className="att-tools">
                {isImage(a) && (
                  <button
                    type="button"
                    className={"att-star" + (a.id === coverId ? " on" : "")}
                    aria-label={a.id === coverId ? "Cover image" : "Make cover"}
                    aria-pressed={a.id === coverId}
                    title={a.id === coverId ? "Cover image" : "Make cover"}
                    onClick={() => a.id !== coverId && makeCover(a.id)}
                  >
                    {a.id === coverId ? "★" : "☆"}
                  </button>
                )}
                <button type="button" className="att-x" aria-label="Remove attachment" title="Remove" onClick={() => remove(a.id)}><IconClose /></button>
              </div>
              <CaptionInput key={a.caption ?? ""} value={a.caption ?? ""} onCommit={(t) => caption(a.id, t)} />
            </div>
          ))}
          {fetching.map((u) => (
            <div key={u} className="att-tile clip fetching" aria-busy="true">
              <div className="att-clip-row">
                <span className="spinner" aria-hidden="true" />
                <span className="att-clip-text">
                  <span className="att-clip-title">Fetching…</span>
                  <span className="att-clip-site">{hostOf(u)}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CaptionInput({ value, onCommit }: { value: string; onCommit: (t: string) => void }) {
  const [v, setV] = useState(value);
  const commit = () => v.trim() !== value.trim() && onCommit(v);
  return (
    <input
      className="att-caption"
      value={v}
      placeholder="Caption"
      aria-label="Caption"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function EditorImageThumb({ slug, att }: { slug: string | null; att: ImageAttachment }) {
  const url = useMediaUrl(slug, att.path, 180);
  return <div className="att-img">{url && <img src={url} alt={att.caption ?? ""} draggable={false} decoding="async" />}</div>;
}

function EditorClipRow({ slug, att, onRefresh }: { slug: string | null; att: ClipAttachment; onRefresh: () => Promise<unknown> }) {
  const fav = useMediaUrl(slug, att.favicon, 32);
  const [busy, setBusy] = useState(false);
  return (
    <div className="att-clip-row" title={att.url}>
      {fav ? <img className="att-fav" src={fav} alt="" draggable={false} /> : <span className="att-fav"><IconClip /></span>}
      <span className="att-clip-text">
        <span className="att-clip-title">{att.title || hostOf(att.url)}</span>
        <span className="att-clip-site">{att.fetch_error ? `Couldn't fetch: ${att.fetch_error}` : att.site || hostOf(att.url)}</span>
      </span>
      <button
        type="button"
        className="att-refresh"
        aria-label="Refresh clip"
        title="Fetch again"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRefresh();
          setBusy(false);
        }}
      >
        {busy ? <span className="spinner" aria-hidden="true" /> : "↻"}
      </button>
    </div>
  );
}

// ===================================================================================== canvas

/** Cover image and the small strip under it. Mounted only for on-screen cards (CanvasArea culls). */
export const CardAttachments = memo(function CardAttachments({
  cardId,
  attachments,
  slug,
  onOpen,
}: {
  cardId: string;
  attachments: Attachment[];
  slug: string | null;
  onOpen: (cardId: string, attId: string, anchor: DOMRect) => void;
}) {
  const { cover, rest } = splitAttachments(attachments);
  const coverUrl = useMediaUrl(slug, cover?.path, 236);
  const shown = rest.slice(0, STRIP_MAX);
  const more = rest.length - shown.length;
  const open = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen(cardId, id, (e.currentTarget as HTMLElement).getBoundingClientRect());
  };
  if (!cover && rest.length === 0) return null;
  return (
    <>
      {cover && (
        <div className="card-cover">
          {coverUrl && <img src={coverUrl} alt={cover.caption ?? ""} draggable={false} decoding="async" />}
          <button type="button" className="cover-expand" aria-label="View image" title="View" onClick={open(cover.id)}>⤢</button>
        </div>
      )}
      {shown.length > 0 && (
        <div className="card-strip">
          {shown.map((a) => (
            <StripThumb key={a.id} slug={slug} att={a} onClick={open(a.id)} />
          ))}
          {more > 0 && (
            <button type="button" className="strip-more" title={`${more} more`} onClick={open(rest[STRIP_MAX].id)}>
              +{more}
            </button>
          )}
        </div>
      )}
    </>
  );
});

function StripThumb({ slug, att, onClick }: { slug: string | null; att: Attachment; onClick: (e: React.MouseEvent) => void }) {
  const url = useMediaUrl(slug, isImage(att) ? att.path : att.favicon, isImage(att) ? 56 : 32);
  const label = att.caption || (isClip(att) ? att.title || hostOf(att.url) : "Image");
  return (
    <button type="button" className={"strip-thumb" + (isClip(att) ? " clip" : "")} title={label} aria-label={label} onClick={onClick}>
      {url ? <img src={url} alt="" draggable={false} decoding="async" /> : isClip(att) ? <IconClip /> : null}
    </button>
  );
}

// ===================================================================================== viewers

/** Full-window image viewer over one card's images: ←/→ to step, Esc to close. */
export function Lightbox({ card, startId, slug, onClose }: { card: Card; startId: string; slug: string | null; onClose: () => void }) {
  const images = card.attachments.filter(isImage);
  const [i, setI] = useState(() => Math.max(0, images.findIndex((a) => a.id === startId)));
  const n = images.length;
  const step = useCallback((d: number) => setI((x) => (x + d + n) % n), [n]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);
  const cur = images[Math.min(i, n - 1)];
  const url = useMediaUrl(slug, cur?.path, 2048);
  // Warm the neighbours so stepping is instant.
  useMediaUrl(slug, n > 1 ? images[(i + 1) % n]?.path : undefined, 2048);
  if (!cur) return null;
  return (
    <Layer onClose={onClose} className="lightbox">
      <div className="lightbox-stage" role="dialog" aria-label={`Image ${i + 1} of ${n}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
        {url ? <img src={url} alt={cur.caption ?? ""} /> : <span className="spinner" aria-hidden="true" />}
        {cur.caption && <p className="lightbox-caption">{cur.caption}</p>}
        {n > 1 && (
          <>
            <button type="button" className="lightbox-nav prev" aria-label="Previous image" onClick={() => step(-1)}>‹</button>
            <button type="button" className="lightbox-nav next" aria-label="Next image" onClick={() => step(1)}>›</button>
            <span className="lightbox-count">{i + 1} / {n}</span>
          </>
        )}
        <button type="button" className="icon-btn lightbox-close" aria-label="Close" onClick={onClose}><IconClose /></button>
      </div>
    </Layer>
  );
}

/** Small popover for a clip on the canvas: preview, caption, Open in browser, Refresh. */
export function ClipPopover({ card, clip, slug, anchor, ws, onClose }: { card: Card; clip: ClipAttachment; slug: string | null; anchor: DOMRect; ws: Workspace; onClose: () => void }) {
  const thumb = useMediaUrl(slug, clip.thumb, 320);
  const fav = useMediaUrl(slug, clip.favicon, 32);
  const [busy, setBusy] = useState(false);
  const W = 320;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - W - 8));
  const below = anchor.bottom + 8;
  const top = below + 300 > window.innerHeight ? Math.max(8, anchor.top - 308) : below;
  return (
    <Layer onClose={onClose}>
      <div className="clip-pop glass" role="dialog" aria-label={clip.title || clip.url} style={{ left, top, width: W }}>
        {thumb && <img className="clip-pop-thumb" src={thumb} alt="" />}
        <div className="clip-pop-head">
          {fav ? <img className="att-fav" src={fav} alt="" /> : <span className="att-fav"><IconClip /></span>}
          <span className="att-clip-site">{clip.site || hostOf(clip.url)}</span>
        </div>
        <h4 className="clip-pop-title">{clip.title || clip.url}</h4>
        {clip.description && <p className="clip-pop-desc">{clip.description}</p>}
        {clip.caption && <p className="clip-pop-caption">“{clip.caption}”</p>}
        {clip.fetch_error && <p className="clip-pop-err">Couldn't fetch: {clip.fetch_error}</p>}
        <div className="editor-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await ws.refreshClip(card.id, clip.id);
              setBusy(false);
            }}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : "↻"} Refresh
          </button>
          <div className="side-spacer" />
          <button type="button" className="btn primary" onClick={() => void api.openUrl(clip.url).catch((e) => ws.setError(String(e)))}>Open in browser</button>
        </div>
      </div>
    </Layer>
  );
}
