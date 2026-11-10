import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { api, type Card, type ProjectData } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { CardEditor } from "./CardEditor";
import { IconCard, IconClip, IconFit, IconImage, IconLink, IconMinus, IconPlus, IconRedo, IconUndo } from "./Icons";

const CARD_W = 236;
const CARD_H = 150;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;

export function CanvasArea({ ws }: { ws: Workspace }) {
  const { data } = ws;
  const [filter, setFilter] = useState<Set<StageId>>(new Set(STAGES));
  const [editing, setEditing] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [clipPrompt, setClipPrompt] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sizeRef = useRef({ w: 1200, h: 800 });

  const toggle = (s: StageId) =>
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const vp = data?.canvas.viewport ?? { x: 300, y: 110, zoom: 1 };
  const camera = { "--pan-x": `${vp.x}px`, "--pan-y": `${vp.y}px`, "--zoom": vp.zoom } as CSSProperties;
  const title = data?.meta.name ?? "";

  const visible = useMemo(() => (data?.cards ?? []).filter((c) => filter.has(c.stage)), [data, filter]);

  // Viewport-cull: only render cards whose box intersects the visible area (plus margin), to hold 60fps at ~500 cards.
  const onScreen = useMemo(() => {
    if (!data) return visible;
    const margin = 400;
    const { w, h } = sizeRef.current;
    const left = (-vp.x - margin) / vp.zoom;
    const top = (-vp.y - margin) / vp.zoom;
    const right = (w - vp.x + margin) / vp.zoom;
    const bottom = (h - vp.y + margin) / vp.zoom;
    return visible.filter((c) => {
      const p = data.canvas.cards[c.id];
      if (!p) return false;
      return p.x + CARD_W >= left && p.x <= right && p.y + CARD_H >= top && p.y <= bottom;
    });
  }, [visible, data, vp]);

  // ----- pan / zoom -----

  const zoomAt = useCallback(
    (screenX: number, screenY: number, newZoom: number) => {
      newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
      const worldX = (screenX - vp.x) / vp.zoom;
      const worldY = (screenY - vp.y) / vp.zoom;
      ws.setViewport({ x: screenX - worldX * newZoom, y: screenY - worldY * newZoom, zoom: newZoom });
    },
    [vp, ws],
  );

  // A native (non-passive) listener, so preventDefault() can stop the browser's own pinch-zoom/scroll.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(sx, sy, vp.zoom * Math.exp(-e.deltaY * 0.0015));
      } else {
        ws.setViewport({ x: vp.x - e.deltaX, y: vp.y - e.deltaY, zoom: vp.zoom });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [vp, ws, zoomAt]);

  const panDrag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      if (linkMode) {
        setLinkMode(false);
        setLinkFrom(null);
        return;
      }
      panDrag.current = { x: e.clientX, y: e.clientY, vx: vp.x, vy: vp.y };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [vp, linkMode],
  );
  const onBackgroundPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!panDrag.current) return;
      const d = panDrag.current;
      ws.setViewport({ x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y), zoom: vp.zoom });
    },
    [ws, vp.zoom],
  );
  const onBackgroundPointerUp = useCallback(() => {
    if (panDrag.current) {
      panDrag.current = null;
      ws.flushCanvas();
    }
  }, [ws]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      sizeRef.current = { w: el.clientWidth, h: el.clientHeight };
    });
    ro.observe(el);
    sizeRef.current = { w: el.clientWidth, h: el.clientHeight };
    return () => ro.disconnect();
  }, []);

  // Keyboard: Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y), ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void ws.redo();
        else void ws.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void ws.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws]);

  const fit = useCallback(() => {
    if (!data || onScreen.length === 0) {
      if (data) ws.setViewport({ x: sizeRef.current.w / 2, y: sizeRef.current.h / 2, zoom: 1 });
      return;
    }
    const pts = visible.map((c) => data.canvas.cards[c.id]).filter(Boolean) as { x: number; y: number }[];
    if (pts.length === 0) return;
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxX = Math.max(...pts.map((p) => p.x + CARD_W));
    const maxY = Math.max(...pts.map((p) => p.y + CARD_H));
    const { w, h } = sizeRef.current;
    const pad = 80;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY)) || 1));
    ws.setViewport({ x: w / 2 - ((minX + maxX) / 2) * zoom, y: h / 2 - ((minY + maxY) / 2) * zoom, zoom });
    ws.flushCanvas();
  }, [data, visible, ws, onScreen.length]);

  const createAt = useCallback(
    async (extra: Parameters<Workspace["createCard"]>[0] = {}) => {
      const { w, h } = sizeRef.current;
      const worldX = (w / 2 - vp.x) / vp.zoom - CARD_W / 2;
      const worldY = (h / 2 - vp.y) / vp.zoom - CARD_H / 2;
      const created = await ws.createCard({ title: "Untitled", x: worldX, y: worldY, ...extra });
      if (created) setEditing(created.id);
      return created;
    },
    [ws, vp],
  );

  const onCardClick = useCallback(
    (card: Card) => {
      if (linkMode) {
        if (!linkFrom) setLinkFrom(card.id);
        else if (linkFrom !== card.id) {
          ws.addLink(linkFrom, card.id);
          setLinkMode(false);
          setLinkFrom(null);
        }
        return;
      }
      setEditing(card.id);
      ws.setContextCard(card.id);
    },
    [linkMode, linkFrom, ws],
  );

  const onDropFile = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      const rect = rootRef.current!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const worldX = (sx - vp.x) / vp.zoom - CARD_W / 2;
      const worldY = (sy - vp.y) / vp.zoom - CARD_H / 2;
      const created = await ws.createCard({ title: file.name.replace(/\.[^.]+$/, "") || "Image", x: worldX, y: worldY });
      if (created) await ws.addImage(created.id, file, file.name);
    },
    [ws, vp],
  );

  const editingCard = data?.cards.find((c) => c.id === editing) ?? null;

  return (
    <main
      ref={rootRef}
      className="canvas"
      aria-label="Canvas"
      style={camera}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDropFile(e)}
    >
      <div className="grid" />
      <div className="world">
        {data && <LinkLayer cards={onScreen} canvas={data.canvas} />}
        {data &&
          onScreen.map((c) => (
            <CardView
              key={c.id}
              card={c}
              pos={data.canvas.cards[c.id]}
              ws={ws}
              linking={linkMode}
              isLinkSource={linkFrom === c.id}
              onOpen={() => onCardClick(c)}
            />
          ))}
      </div>

      {data && data.cards.length === 0 && (
        <div className="empty">
          <div className="empty-title">{data.is_inbox ? "Your Inbox is empty" : "A blank canvas"}</div>
          <p>
            {data.is_inbox
              ? "Raw ideas land here. Capture one with the Card button, or press the global hotkey from anywhere."
              : "Add your first card with the Card button below."}
          </p>
        </div>
      )}

      <div className="pill title-pill">
        <span className="proj-title">{title || "…"}</span>
        <span className="pill-sep" />
        <div className="stage-filter" role="group" aria-label="Stage filter">
          {STAGES.map((s) => (
            <button key={s} type="button" className={"filter" + (filter.has(s) ? " on" : "")} aria-pressed={filter.has(s)} onClick={() => toggle(s)}>
              <span className={`dot dot-${s}`} aria-hidden="true" />
              {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
        <span className="pill-sep" />
        <button type="button" className="icon-btn" aria-label="Undo" disabled={!ws.canUndo} onClick={() => void ws.undo()}><IconUndo /></button>
        <button type="button" className="icon-btn" aria-label="Redo" disabled={!ws.canRedo} onClick={() => void ws.redo()}><IconRedo /></button>
      </div>

      {data && data.warnings.length > 0 && <Warnings data={data} />}

      <div className="pill zoom-pill" aria-label="Zoom">
        <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, vp.zoom / 1.2)}><IconMinus /></button>
        <span className="zoom-val">{Math.round(vp.zoom * 100)}%</span>
        <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, vp.zoom * 1.2)}><IconPlus /></button>
        <button type="button" className="icon-btn" aria-label="Fit to content" onClick={fit}><IconFit /></button>
      </div>

      <div className="pill toolbar" role="toolbar" aria-label="Add">
        <button type="button" className="tool" disabled={!data} onClick={() => void createAt()}>
          <IconCard />
          <span>Card</span>
        </button>
        <button type="button" className={"tool" + (linkMode ? " on" : "")} disabled={!data} onClick={() => { setLinkMode((v) => !v); setLinkFrom(null); }}>
          <IconLink />
          <span>{linkMode ? "Pick two cards…" : "Link"}</span>
        </button>
        <button type="button" className="tool" disabled={!data} onClick={() => fileInputRef.current?.click()}>
          <IconImage />
          <span>Image</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const created = await createAt({ title: file.name.replace(/\.[^.]+$/, "") || "Image" });
            if (created) await ws.addImage(created.id, file, file.name);
          }}
        />
        <button type="button" className="tool" disabled={!data} onClick={() => setClipPrompt(true)}>
          <IconClip />
          <span>Web clip</span>
        </button>
      </div>

      {clipPrompt && <WebClipPrompt onClose={() => setClipPrompt(false)} onCreate={(url, name) => createAt({ title: name || url, fields: { url, clip_title: name } })} />}
      {editingCard && <CardEditor card={editingCard} ws={ws} onClose={() => setEditing(null)} />}
    </main>
  );
}

function Warnings({ data }: { data: ProjectData }) {
  const n = data.warnings.length;
  return (
    <div className="pill warn-pill" role="status" title={data.warnings.join("\n")}>
      {n === 1 ? "1 card file couldn't be read" : `${n} card files couldn't be read`}
    </div>
  );
}

function LinkLayer({ cards, canvas }: { cards: Card[]; canvas: ProjectData["canvas"] }) {
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const lines: { x1: number; y1: number; x2: number; y2: number; label?: string; key: string }[] = [];
  for (const c of cards) {
    const from = canvas.cards[c.id];
    if (!from) continue;
    for (const l of c.links) {
      const to = canvas.cards[l.to];
      if (!to || !byId.has(l.to)) continue;
      lines.push({
        x1: from.x + CARD_W / 2,
        y1: from.y + CARD_H / 2,
        x2: to.x + CARD_W / 2,
        y2: to.y + CARD_H / 2,
        label: l.label,
        key: `${c.id}-${l.to}`,
      });
    }
  }
  if (lines.length === 0) return null;
  const pad = 2000;
  return (
    <svg className="link-layer" width={pad * 2} height={pad * 2} style={{ left: -pad, top: -pad }}>
      <g transform={`translate(${pad},${pad})`}>
        {lines.map((l) => (
          <g key={l.key}>
            <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="link-line" />
            {l.label && (
              <text x={(l.x1 + l.x2) / 2} y={(l.y1 + l.y2) / 2} className="link-label" textAnchor="middle">
                {l.label}
              </text>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}

const CardView = memo(function CardView({
  card,
  pos,
  ws,
  linking,
  isLinkSource,
  onOpen,
}: {
  card: Card;
  pos?: { x: number; y: number };
  ws: Workspace;
  linking: boolean;
  isLinkSource: boolean;
  onOpen: () => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const image = typeof card.fields.image === "string" ? card.fields.image : null;
  useEffect(() => {
    if (!image || !ws.active) return;
    let cancelled = false;
    api.readMedia(ws.active, image).then((u) => !cancelled && setImgUrl(u)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [image, ws.active]);

  const dragState = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 || linking) return;
      e.stopPropagation();
      dragState.current = { x: e.clientX, y: e.clientY, ox: pos?.x ?? 0, oy: pos?.y ?? 0, moved: false };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [pos, linking],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragState.current;
      if (!d) return;
      const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue("--zoom")) || 1;
      const dx = (e.clientX - d.x) / zoom;
      const dy = (e.clientY - d.y) / zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      if (d.moved) ws.moveCard(card.id, { x: d.ox + dx, y: d.oy + dy });
    },
    [card.id, ws],
  );
  const onPointerUp = useCallback(() => {
    const d = dragState.current;
    dragState.current = null;
    if (d?.moved) ws.flushCanvas();
    else onOpen();
  }, [ws, onOpen]);

  if (!pos) return null;
  const url = typeof card.fields.url === "string" ? card.fields.url : null;
  return (
    <article
      className={`card stage-${card.stage}` + (card.ghost ? " ghost" : "") + (isLinkSource ? " link-source" : "") + (linking ? " linkable" : "")}
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {card.ghost && <div className="ghost-label">Claude suggests</div>}
      <div className="card-head">
        <span className={`dot dot-${card.stage}`} aria-hidden="true" />
        <span className="stage-name">{STAGE_LABEL[card.stage]}</span>
      </div>
      <h3>{card.title}</h3>
      {imgUrl && <img className="card-image" src={imgUrl} alt="" />}
      {url && <a className="card-clip" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{url}</a>}
      {card.body && <p className="card-body">{card.body}</p>}
      {card.tags.length > 0 && <div className="tags">{card.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      {card.ghost && (
        <div className="ghost-actions">
          <button type="button" className="btn primary" onClick={(e) => { e.stopPropagation(); void ws.updateCard(card.id, { ghost: false }); }}>Keep</button>
          <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); void ws.deleteCard(card.id); }}>Dismiss</button>
        </div>
      )}
    </article>
  );
});

function WebClipPrompt({ onClose, onCreate }: { onClose: () => void; onCreate: (url: string, title: string) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal glass clip-prompt">
        <h3>Web clip</h3>
        <input className="name-input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Title (optional)" />
        <div className="editor-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!url.trim()}
            onClick={() => {
              onCreate(url.trim(), name.trim());
              onClose();
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
