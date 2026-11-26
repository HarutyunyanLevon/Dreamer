import { memo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Frame } from "../api";
import { HANDLES, type HandleDir, type Rect } from "./cardGeometry";
import { swatchOf } from "./kinds";

/** Mirrors MIN_FRAME_SIDE / MAX_FRAME_SIDE in src-tauri/src/model.rs. */
const MIN_FRAME = 80;
const MAX_FRAME = 100_000;
export const FRAME_PAD = 40;
export const DEFAULT_FRAME_TITLE = "Untitled frame";

/** Membership is computed, never stored: a card belongs to a frame while its centre is inside it. */
export const centerInside = (f: Rect, r: Rect) => {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
};

function resizeFrame(s: Rect, dir: HandleDir, dx: number, dy: number): Rect {
  const clamp = (v: number) => Math.min(MAX_FRAME, Math.max(MIN_FRAME, v));
  const w = clamp(dir.includes("e") ? s.w + dx : dir.includes("w") ? s.w - dx : s.w);
  const h = clamp(dir.includes("s") ? s.h + dy : dir.includes("n") ? s.h - dy : s.h);
  const x = dir.includes("w") ? s.x + s.w - w : s.x;
  const y = dir.includes("n") ? s.y + s.h - h : s.y;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** A frame's tint: a swatch key gets its themed class; any other colour string is used as is. */
function frameTint(color: string | undefined): { className: string; style: CSSProperties } {
  const sw = swatchOf(color, null);
  if (sw) return { className: ` tint-${sw}`, style: {} };
  return color ? { className: "", style: { ["--tint" as string]: color } } : { className: "", style: {} };
}

/** What a frame gesture needs from the canvas; one stable object so FrameView stays memoised. */
export interface FrameControls {
  zoom: () => number;
  /** Positions of the cards inside the frame right now. */
  members: (id: string) => { id: string; x: number; y: number }[];
  begin: () => unknown;
  live: (id: string, patch: Partial<Frame>, cardMoves?: Record<string, { x: number; y: number }>) => void;
  commit: (label: string, before: unknown) => void;
  rename: (id: string, title: string) => void;
  select: (id: string | null) => void;
  setRenaming: (id: string | null) => void;
}

export const FrameView = memo(function FrameView({
  id,
  frame,
  selected,
  renaming,
  ctl,
}: {
  id: string;
  frame: Frame;
  selected: boolean;
  renaming: boolean;
  ctl: FrameControls;
}) {
  // ----- move (by the title tab): member cards come along, one undo entry -----
  const drag = useRef<{ x: number; y: number; zoom: number; fx: number; fy: number; members: { id: string; x: number; y: number }[]; before: unknown; moved: boolean } | null>(null);
  const onTabDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || renaming) return;
    e.stopPropagation();
    ctl.select(id);
    drag.current = { x: e.clientX, y: e.clientY, zoom: ctl.zoom(), fx: frame.x, fy: frame.y, members: ctl.members(id), before: ctl.begin(), moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onTabMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / d.zoom;
    const dy = (e.clientY - d.y) / d.zoom;
    if (!d.moved && Math.hypot(dx, dy) * d.zoom < 3) return;
    d.moved = true;
    const moves: Record<string, { x: number; y: number }> = {};
    for (const m of d.members) moves[m.id] = { x: Math.round(m.x + dx), y: Math.round(m.y + dy) };
    ctl.live(id, { x: Math.round(d.fx + dx), y: Math.round(d.fy + dy) }, moves);
  };
  const onTabUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    ctl.commit("move frame", d.before);
  };

  // ----- resize (edge and corner handles); membership simply follows the new box -----
  const rs = useRef<{ dir: HandleDir; x: number; y: number; zoom: number; start: Rect; before: unknown } | null>(null);
  const onHandleDown = (dir: HandleDir) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    ctl.select(id);
    rs.current = { dir, x: e.clientX, y: e.clientY, zoom: ctl.zoom(), start: { x: frame.x, y: frame.y, w: frame.w, h: frame.h }, before: ctl.begin() };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent) => {
    const r = rs.current;
    if (!r) return;
    e.stopPropagation();
    ctl.live(id, resizeFrame(r.start, r.dir, (e.clientX - r.x) / r.zoom, (e.clientY - r.y) / r.zoom));
  };
  const onHandleUp = (e: ReactPointerEvent) => {
    const r = rs.current;
    rs.current = null;
    if (!r) return;
    e.stopPropagation();
    ctl.commit("resize frame", r.before);
  };

  const tint = frameTint(frame.color);
  return (
    <div
      className={"frame" + tint.className + (selected ? " selected" : "")}
      data-frame={id}
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, ...tint.style }}
    >
      {renaming ? (
        <input
          className="frame-tab frame-rename"
          autoFocus
          defaultValue={frame.title}
          aria-label="Frame title"
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
            const t = e.currentTarget.value.trim() || DEFAULT_FRAME_TITLE;
            ctl.setRenaming(null);
            if (t !== frame.title) ctl.rename(id, t);
          }}
        />
      ) : (
        <div
          className="frame-tab"
          data-frame-tab={id}
          title="Drag to move the frame and its cards · double-click to rename"
          onPointerDown={onTabDown}
          onPointerMove={onTabMove}
          onPointerUp={onTabUp}
          onPointerCancel={onTabUp}
          onDoubleClick={(e) => {
            e.stopPropagation();
            ctl.setRenaming(id);
          }}
        >
          {frame.title || DEFAULT_FRAME_TITLE}
        </div>
      )}
      {HANDLES.map((d) => (
        <div
          key={d}
          className={`rh rh-${d}`}
          aria-hidden="true"
          onPointerDown={onHandleDown(d)}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        />
      ))}
    </div>
  );
});
