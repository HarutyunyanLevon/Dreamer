import { memo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Card, Folder, Pos } from "../api";
import { useMediaUrl } from "../util/media";
import { FOLDER_H, FOLDER_W, HANDLES, type HandleDir, type Rect } from "./cardGeometry";
import { frameTint } from "./Frames";
import { IconPin } from "./Icons";
import { isClip, isImage } from "./Attachments";

export const DEFAULT_FOLDER_TITLE = "New folder";
const MIN_FW = 140;
const MIN_FH = 96;
const MAX_SIDE = 4000;

function resizeFolder(s: Rect, dir: HandleDir, dx: number, dy: number): Rect {
  const clamp = (v: number, min: number) => Math.min(MAX_SIDE, Math.max(min, v));
  const w = clamp(dir.includes("e") ? s.w + dx : dir.includes("w") ? s.w - dx : s.w, MIN_FW);
  const h = clamp(dir.includes("s") ? s.h + dy : dir.includes("n") ? s.h - dy : s.h, MIN_FH);
  const x = dir.includes("w") ? s.x + s.w - w : s.x;
  const y = dir.includes("n") ? s.y + s.h - h : s.y;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** What a folder node needs from the canvas; one stable object so FolderView stays memoised. */
export interface FolderControls {
  zoom: () => number;
  /** Undo snapshot at gesture start. */
  begin: () => unknown;
  live: (id: string, patch: Partial<Pos>) => void;
  commit: (label: string, before: unknown) => void;
  /** A drag moved over (x, y): highlight the drop target there. */
  dragOver: (x: number, y: number, id: string) => void;
  /** Drag released at (x, y): true when it was dropped into a folder (the move is done). */
  drop: (x: number, y: number, id: string) => boolean;
  click: (id: string, additive: boolean) => void;
  open: (id: string) => void;
  menu: (id: string, x: number, y: number) => void;
  front: (id: string) => void;
  rename: (id: string, title: string) => void;
  setRenaming: (id: string | null) => void;
  unpin: (id: string) => void;
}

export interface FolderPreview {
  id: string;
  title: string;
  /** media/ path of the first image (a clip's thumbnail counts). */
  cover?: string;
}

/** Up to four child cards, covers first. */
export function previewsOf(cards: Card[]): FolderPreview[] {
  const withCover = cards.map((c) => {
    const img = c.attachments.find(isImage);
    const clip = c.attachments.find(isClip);
    return { id: c.id, title: c.title || "Untitled", cover: img?.path ?? (clip && isClip(clip) ? clip.thumb : undefined) };
  });
  return [...withCover.filter((p) => p.cover), ...withCover.filter((p) => !p.cover)].slice(0, 4);
}

function Preview({ p, slug }: { p: FolderPreview; slug: string | null }) {
  const url = useMediaUrl(slug, p.cover, 96);
  return (
    <div className={"folder-prev" + (url ? " cover" : "")} title={p.title}>
      {url ? <img src={url} alt="" draggable={false} decoding="async" /> : <span>{p.title}</span>}
    </div>
  );
}

export const FolderView = memo(function FolderView({
  id,
  folder,
  pos,
  z,
  selected,
  renaming,
  dropHint,
  cards,
  folders,
  previews,
  slug,
  ctl,
}: {
  id: string;
  folder: Folder;
  pos: Pos;
  z: number;
  selected: boolean;
  renaming: boolean;
  /** Something is being dragged over it. */
  dropHint: boolean;
  cards: number;
  folders: number;
  previews: FolderPreview[];
  slug: string | null;
  ctl: FolderControls;
}) {
  const drag = useRef<{ x: number; y: number; zoom: number; ox: number; oy: number; before: unknown; moved: boolean } | null>(null);
  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || renaming) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    e.stopPropagation();
    ctl.front(id);
    drag.current = { x: e.clientX, y: e.clientY, zoom: ctl.zoom(), ox: pos.x, oy: pos.y, before: ctl.begin(), moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || pos.pinned) return;
    const dx = (e.clientX - d.x) / d.zoom;
    const dy = (e.clientY - d.y) / d.zoom;
    if (!d.moved && Math.hypot(dx, dy) * d.zoom < 3) return;
    d.moved = true;
    ctl.live(id, { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) });
    ctl.dragOver(e.clientX, e.clientY, id);
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      ctl.click(id, e.shiftKey || e.ctrlKey || e.metaKey);
      return;
    }
    if (e.type === "pointerup" && ctl.drop(e.clientX, e.clientY, id)) return;
    ctl.dragOver(-1, -1, id);
    ctl.commit("move folder", d.before);
  };

  const rs = useRef<{ dir: HandleDir; x: number; y: number; zoom: number; start: Rect; before: unknown } | null>(null);
  const onHandleDown = (dir: HandleDir) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    ctl.front(id);
    rs.current = { dir, x: e.clientX, y: e.clientY, zoom: ctl.zoom(), start: { x: pos.x, y: pos.y, w: pos.w ?? FOLDER_W, h: pos.h ?? FOLDER_H }, before: ctl.begin() };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent) => {
    const r = rs.current;
    if (!r) return;
    e.stopPropagation();
    ctl.live(id, resizeFolder(r.start, r.dir, (e.clientX - r.x) / r.zoom, (e.clientY - r.y) / r.zoom));
  };
  const onHandleUp = (e: ReactPointerEvent) => {
    const r = rs.current;
    rs.current = null;
    if (!r) return;
    e.stopPropagation();
    ctl.commit("resize folder", r.before);
  };

  const tint = frameTint(folder.color);
  const title = folder.title.trim() || "Untitled folder";
  const count = [cards ? `${cards} card${cards === 1 ? "" : "s"}` : "", folders ? `${folders} folder${folders === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "Empty";
  return (
    <article
      className={"folder-node" + tint.className + (selected ? " selected" : "") + (dropHint ? " drop-hover" : "") + (pos.pinned ? " pinned" : "")}
      data-folder-node={id}
      data-drop-folder={id}
      style={{ left: pos.x, top: pos.y, width: pos.w ?? FOLDER_W, height: pos.h ?? FOLDER_H, zIndex: z, ...tint.style }}
      aria-label={`Folder ${title}, ${count}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        ctl.open(id);
      }}
    >
      <div className="folder-tab" aria-hidden="true" />
      <div className="folder-body">
        <div className="folder-head">
          {renaming ? (
            <input
              className="folder-rename"
              autoFocus
              defaultValue={folder.title}
              aria-label="Folder name"
              onFocus={(e) => e.currentTarget.select()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  ctl.setRenaming(null);
                }
              }}
              onBlur={(e) => {
                const t = e.currentTarget.value.trim() || DEFAULT_FOLDER_TITLE;
                ctl.setRenaming(null);
                if (t !== folder.title) ctl.rename(id, t);
              }}
            />
          ) : (
            <h3 className="folder-title">{title}</h3>
          )}
          <button
            type="button"
            className="card-menu-btn"
            aria-label={`Folder menu for ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              ctl.menu(id, r.left, r.bottom + 4);
            }}
          >
            ⋯
          </button>
        </div>
        <div className="folder-count">{count}</div>
        {previews.length > 0 && (
          <div className="folder-previews">
            {previews.map((p) => (
              <Preview key={p.id} p={p} slug={slug} />
            ))}
          </div>
        )}
      </div>
      {pos.pinned && (
        <button type="button" className="pin-badge" title="Position pinned. Click to unpin" aria-label="Unpin position" onClick={(e) => { e.stopPropagation(); ctl.unpin(id); }}>
          <IconPin />
        </button>
      )}
      {HANDLES.map((d) => (
        <div key={d} className={`rh rh-${d}`} aria-hidden="true" onPointerDown={onHandleDown(d)} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} />
      ))}
    </article>
  );
});
