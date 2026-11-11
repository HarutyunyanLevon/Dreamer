import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { api, type Card, type Pos, type ProjectData } from "../api";
import { renderMarkdown } from "../util/markdown";
import { useEscClose } from "../util/useEscClose";
import { CARD_H, CARD_W, HANDLES, cardRect, displayStack, resizeRect, type HandleDir, type Rect } from "./cardGeometry";
import type { GhostLink, Workspace } from "../state/useWorkspace";
import { useTheme } from "../theme/ThemeContext";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { Modal } from "../ui/Modal";
import { ScrollArea, wheelBelongsToContent } from "../ui/Scroll";
import { dialogOpen } from "../util/useEscClose";
import { branchGroup } from "./BranchCompare";
import { CardEditor } from "./CardEditor";
import { IconCard, IconClip, IconFit, IconImage, IconLink, IconMinus, IconPlus, IconRedo, IconTrash as IconTrashCan, IconUndo } from "./Icons";
import { TrashView } from "./TrashView";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
/** Floating panels over the canvas (sidebar left, chat right, incl. margins), to center focused cards in the free column. */
const LEFT_PANEL = 240;
const RIGHT_PANEL = 356;
const FOCUS_ZOOM = 1.15;

export function CanvasArea({ ws }: { ws: Workspace }) {
  const { data } = ws;
  const [filter, setFilter] = useState<Set<StageId>>(new Set(STAGES));
  const [editing, setEditing] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [clipPrompt, setClipPrompt] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const { themes } = useTheme();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sizeRef = useRef({ w: 1200, h: 800 });
  const [cameraAnim, setCameraAnim] = useState(false);
  const cameraAnimTimer = useRef<number | undefined>(undefined);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  // Rendered heights of auto-height cards (reported by each CardView), for culling, link
  // endpoints and the "fully hidden" stacking rule. Batched into one re-render per frame.
  const heights = useRef(new Map<string, number>());
  const [measureTick, setMeasureTick] = useState(0);
  const measureRaf = useRef(0);
  const onMeasure = useCallback((id: string, h: number) => {
    if (heights.current.get(id) === h) return;
    heights.current.set(id, h);
    if (!measureRaf.current) {
      measureRaf.current = requestAnimationFrame(() => {
        measureRaf.current = 0;
        setMeasureTick((t) => t + 1);
      });
    }
  }, []);
  const rectOf = useCallback(
    (id: string): Rect | undefined => {
      const p = data?.canvas.cards[id];
      return p ? cardRect(p, heights.current.get(id)) : undefined;
    },
    // measureTick: heights changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, measureTick],
  );

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
      const r = rectOf(c.id);
      if (!r) return false;
      return r.x + r.w >= left && r.x <= right && r.y + r.h >= top && r.y <= bottom;
    });
  }, [visible, data, vp, rectOf]);

  const stack = useMemo(
    () => displayStack(onScreen.map((c) => c.id), rectOf, (id) => data?.canvas.cards[id]),
    [onScreen, rectOf, data],
  );

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
      // Popups, pills and modals inside the canvas, and card bodies that can still scroll, keep
      // the wheel: the browser scrolls them natively and the canvas does not move.
      const t = e.target as Element;
      if (t.closest?.("[data-wheel-boundary]")) return;
      // Ctrl+wheel always zooms the canvas, even over a scrollable card body.
      if (!(e.ctrlKey || e.metaKey) && wheelBelongsToContent(t, el, e.deltaX, e.deltaY)) return;
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
      } else if (e.key === "Escape" && linkMode && !dialogOpen()) {
        setLinkMode(false);
        setLinkFrom(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, linkMode]);

  // Pan/zoom to a card asked for by a search result (chat chip or Ctrl+K), then select it.
  const { focusRequest, clearFocus, setError } = ws;
  useEffect(() => {
    if (!focusRequest || !data || data.slug !== focusRequest.slug) return;
    const card = data.cards.find((c) => c.id === focusRequest.id);
    const pos = data.canvas.cards[focusRequest.id];
    clearFocus();
    if (!card || !pos) {
      setError("That card isn't on this canvas any more (it may have been trashed).");
      return;
    }
    if (!filter.has(card.stage)) setFilter((prev) => new Set(prev).add(card.stage));
    const r = cardRect(pos, heights.current.get(card.id));
    const { w, h } = sizeRef.current;
    const zoom = Math.min(MAX_ZOOM, Math.max(FOCUS_ZOOM, vp.zoom));
    const cx = w > LEFT_PANEL + RIGHT_PANEL + 200 ? (LEFT_PANEL + w - RIGHT_PANEL) / 2 : w / 2;
    setCameraAnim(true);
    ws.setViewport({ x: cx - (r.x + r.w / 2) * zoom, y: h / 2 - (r.y + Math.min(r.h, h / zoom - 80) / 2) * zoom, zoom });
    // Not an effect cleanup: the viewport change re-renders right away and must not cancel this.
    window.clearTimeout(cameraAnimTimer.current);
    cameraAnimTimer.current = window.setTimeout(() => setCameraAnim(false), 500);
  }, [focusRequest, data, filter, vp.zoom, ws, clearFocus, setError]);

  const fit = useCallback(() => {
    if (!data || onScreen.length === 0) {
      if (data) ws.setViewport({ x: sizeRef.current.w / 2, y: sizeRef.current.h / 2, zoom: 1 });
      return;
    }
    const pts = visible.map((c) => rectOf(c.id)).filter(Boolean) as Rect[];
    if (pts.length === 0) return;
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxX = Math.max(...pts.map((p) => p.x + p.w));
    const maxY = Math.max(...pts.map((p) => p.y + p.h));
    const { w, h } = sizeRef.current;
    const pad = 80;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY)) || 1));
    ws.setViewport({ x: w / 2 - ((minX + maxX) / 2) * zoom, y: h / 2 - ((minY + maxY) / 2) * zoom, zoom });
    void ws.flushCanvas();
  }, [data, visible, ws, onScreen.length, rectOf]);

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

  const openMenu = useCallback((id: string, x: number, y: number) => setMenu({ id, x, y }), []);

  // Stable props for CardView, so React.memo skips every card except the one that changed while
  // panning/dragging (the `ws` object itself is new on every render).
  const clickRef = useRef(onCardClick);
  clickRef.current = onCardClick;
  const onOpenCard = useCallback((c: Card) => clickRef.current(c), []);
  const { moveCard, resizeCard, flushCanvas, bringToFront, updateCard, deleteCard } = ws;
  const cardActions = useMemo(
    () => ({ moveCard, resizeCard, flushCanvas, bringToFront, updateCard, deleteCard }),
    [moveCard, resizeCard, flushCanvas, bringToFront, updateCard, deleteCard],
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
      className={"canvas" + (cameraAnim ? " camera-anim" : "")}
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
        {data && <LinkLayer cards={onScreen} rectOf={rectOf} ghosts={ws.ghostLinks} />}
        {/* Cards get their own stacking context, so card z-order never covers ghost-link controls. */}
        <div className="cards-layer">
          {data &&
            onScreen.map((c) => (
              <CardView
                key={c.id}
                card={c}
                pos={data.canvas.cards[c.id]}
                z={stack.get(c.id) ?? 0}
                active={ws.active}
                actions={cardActions}
                linking={linkMode}
                isLinkSource={linkFrom === c.id}
                selected={ws.contextCardId === c.id}
                onOpen={onOpenCard}
                onMenu={openMenu}
                onMeasure={onMeasure}
              />
            ))}
        </div>
        {data && <GhostLinkControls cards={onScreen} rectOf={rectOf} ghosts={ws.ghostLinks} ws={ws} />}
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
      {data && data.cards.length > 0 && visible.length === 0 && (
        <div className="empty">
          <div className="empty-title">No cards in this filter</div>
          <p>Turn a stage back on above to see the rest of this canvas.</p>
        </div>
      )}

      <div className="pill title-pill" data-wheel-boundary="">
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
        {data && !data.is_inbox && (
          <div className="theme-picker">
            <button type="button" className="chip" onClick={() => setThemePickerOpen((v) => !v)}>
              Theme: {themes.find((t) => t.id === data.meta.theme)?.name ?? "Workspace default"}
            </button>
            {themePickerOpen && (
              <ScrollArea boundary className="theme-picker-pop glass">
                <button type="button" className="theme-picker-row" onClick={() => { void ws.setProjectTheme(null); setThemePickerOpen(false); }}>
                  Workspace default
                </button>
                {themes.map((t) => (
                  <button key={t.id} type="button" className="theme-picker-row" onClick={() => { void ws.setProjectTheme(t.id); setThemePickerOpen(false); }}>
                    {t.name}
                  </button>
                ))}
              </ScrollArea>
            )}
          </div>
        )}
      </div>

      {data && data.warnings.length > 0 && <Warnings data={data} />}

      <div className="pill zoom-pill" aria-label="Zoom" data-wheel-boundary="">
        <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, vp.zoom / 1.2)}><IconMinus /></button>
        <span className="zoom-val">{Math.round(vp.zoom * 100)}%</span>
        <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, vp.zoom * 1.2)}><IconPlus /></button>
        <button type="button" className="icon-btn" aria-label="Fit to content" onClick={fit}><IconFit /></button>
      </div>

      <div className="pill toolbar" role="toolbar" aria-label="Add" data-wheel-boundary="">
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
        <button type="button" className="tool" disabled={!data} onClick={() => setTrashOpen(true)}>
          <IconTrashCan />
          <span>Trash</span>
        </button>
      </div>

      {clipPrompt && <WebClipPrompt onClose={() => setClipPrompt(false)} onCreate={(url, name) => createAt({ title: name || url, fields: { url, clip_title: name } })} />}
      {menu && data?.canvas.cards[menu.id] && (
        <CardMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onOpen={() => {
            const c = data.cards.find((x) => x.id === menu.id);
            if (c) onCardClick(c);
          }}
          onFront={() => ws.bringToFront(menu.id)}
          onBack={() => ws.sendToBack(menu.id)}
        />
      )}
      {editingCard && <CardEditor card={editingCard} ws={ws} onClose={() => setEditing(null)} />}
      {trashOpen && <TrashView ws={ws} onClose={() => setTrashOpen(false)} />}
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

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

type RectOf = (id: string) => Rect | undefined;

/** Ghost links whose two cards are both on screen, with their endpoints. */
function placedGhosts(cards: Card[], rectOf: RectOf, ghosts: GhostLink[]) {
  const ids = new Set(cards.map((c) => c.id));
  return ghosts.flatMap((g) => {
    const a = rectOf(g.from);
    const b = rectOf(g.to);
    if (!a || !b || !ids.has(g.from) || !ids.has(g.to)) return [];
    const p1 = center(a);
    const p2 = center(b);
    return [{ g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
  });
}

/** Keep/Dismiss pill at the midpoint of each proposed (ghost) link. */
function GhostLinkControls({ cards, rectOf, ghosts, ws }: { cards: Card[]; rectOf: RectOf; ghosts: GhostLink[]; ws: Workspace }) {
  return (
    <>
      {placedGhosts(cards, rectOf, ghosts).map(({ g, x1, y1, x2, y2 }) => (
        <div
          key={g.key}
          className="ghost-link-ctl"
          data-wheel-boundary=""
          style={{ left: (x1 + x2) / 2, top: (y1 + y2) / 2 }}
          title={g.reason}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="ghost-link-label">{g.label || "Claude suggests a link"}</span>
          <button type="button" className="btn primary" onClick={() => void ws.keepGhostLink(g)}>Keep</button>
          <button type="button" className="btn" onClick={() => ws.dismissGhostLink(g)}>Dismiss</button>
        </div>
      ))}
    </>
  );
}

function LinkLayer({ cards, rectOf, ghosts }: { cards: Card[]; rectOf: RectOf; ghosts: GhostLink[] }) {
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const ghostLines = placedGhosts(cards, rectOf, ghosts);
  const lines: { x1: number; y1: number; x2: number; y2: number; label?: string; key: string }[] = [];
  for (const c of cards) {
    const from = rectOf(c.id);
    if (!from) continue;
    for (const l of c.links) {
      const to = rectOf(l.to);
      if (!to || !byId.has(l.to)) continue;
      const a = center(from);
      const b = center(to);
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, label: l.label, key: `${c.id}-${l.to}` });
    }
  }
  if (lines.length === 0 && ghostLines.length === 0) return null;
  const pad = 4000;
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
        {ghostLines.map(({ g, x1, y1, x2, y2 }) => (
          <line key={`ghost-${g.key}`} x1={x1} y1={y1} x2={x2} y2={y2} className="link-line ghost-link" />
        ))}
      </g>
    </svg>
  );
}

type CardActions = Pick<Workspace, "moveCard" | "resizeCard" | "flushCanvas" | "bringToFront" | "updateCard" | "deleteCard">;

const currentZoom = () => Number(getComputedStyle(document.documentElement.querySelector(".canvas") ?? document.documentElement).getPropertyValue("--zoom")) || 1;

const CardView = memo(function CardView({
  card,
  pos,
  z,
  active,
  actions: ws,
  linking,
  isLinkSource,
  selected,
  onOpen,
  onMenu,
  onMeasure,
}: {
  card: Card;
  pos?: Pos;
  z: number;
  active: string | null;
  actions: CardActions;
  linking: boolean;
  isLinkSource: boolean;
  selected: boolean;
  onOpen: (card: Card) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onMeasure: (id: string, h: number) => void;
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const elRef = useRef<HTMLElement | null>(null);
  const image = typeof card.fields.image === "string" ? card.fields.image : null;
  useEffect(() => {
    if (!image || !active) return;
    let cancelled = false;
    api.readMedia(active, image).then((u) => !cancelled && setImgUrl(u)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [image, active]);

  // Report the rendered height (auto-height cards grow with their content).
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    onMeasure(card.id, el.offsetHeight);
    const ro = new ResizeObserver(() => onMeasure(card.id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [card.id, onMeasure]);

  const bodyHtml = useMemo(() => (card.body ? renderMarkdown(card.body) : ""), [card.body]);

  // ----- move -----
  const dragState = useRef<{ x: number; y: number; ox: number; oy: number; zoom: number; moved: boolean; last: { x: number; y: number } } | null>(null);
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 || linking) return;
      const t = e.target as HTMLElement;
      // Let the card body's own scrollbar be dragged.
      if (t.classList.contains("scroll") && e.nativeEvent.offsetX >= t.clientWidth) return;
      if (t.closest("button, a, input, textarea")) return;
      e.stopPropagation();
      // The last card you touch comes to the front.
      ws.bringToFront(card.id);
      dragState.current = { x: e.clientX, y: e.clientY, ox: pos?.x ?? 0, oy: pos?.y ?? 0, zoom: currentZoom(), moved: false, last: { x: pos?.x ?? 0, y: pos?.y ?? 0 } };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [pos, linking, ws, card.id],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragState.current;
      if (!d) return;
      const dx = (e.clientX - d.x) / d.zoom;
      const dy = (e.clientY - d.y) / d.zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      if (d.moved) {
        d.last = { x: d.ox + dx, y: d.oy + dy };
        ws.moveCard(card.id, d.last);
      }
    },
    [card.id, ws],
  );
  const onPointerUp = useCallback(() => {
    const d = dragState.current;
    dragState.current = null;
    if (!d) return;
    if (d.moved) {
      ws.moveCard(card.id, d.last, { undoable: true, from: { x: d.ox, y: d.oy } });
      void ws.flushCanvas();
    } else onOpen(card);
  }, [ws, onOpen, card]);

  // ----- resize (edge and corner handles) -----
  const resizeState = useRef<{ dir: HandleDir; x: number; y: number; zoom: number; start: Rect; from: Pos; last: Rect | null } | null>(null);
  const onHandleDown = (dir: HandleDir) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || !pos || !elRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    ws.bringToFront(card.id);
    // Measure the real box: an auto-height card becomes fixed-height from here on.
    const start = { x: pos.x, y: pos.y, w: pos.w ?? elRef.current.offsetWidth, h: pos.h ?? elRef.current.offsetHeight };
    resizeState.current = { dir, x: e.clientX, y: e.clientY, zoom: currentZoom(), start, from: { ...pos }, last: null };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent) => {
    const r = resizeState.current;
    if (!r) return;
    e.stopPropagation();
    r.last = resizeRect(r.start, r.dir, (e.clientX - r.x) / r.zoom, (e.clientY - r.y) / r.zoom);
    ws.resizeCard(card.id, r.last);
  };
  const onHandleUp = (e: ReactPointerEvent) => {
    const r = resizeState.current;
    resizeState.current = null;
    if (!r) return;
    e.stopPropagation();
    if (r.last) ws.resizeCard(card.id, r.last, { undoable: true, from: r.from });
  };

  if (!pos) return null;
  const url = typeof card.fields.url === "string" ? card.fields.url : null;
  const fixed = pos.h !== undefined;
  const style: CSSProperties = { left: pos.x, top: pos.y, width: pos.w ?? CARD_W, height: pos.h, zIndex: z };
  return (
    <article
      ref={elRef}
      className={
        `card stage-${card.stage}` +
        (card.ghost ? " ghost" : "") +
        (isLinkSource ? " link-source" : "") +
        (linking ? " linkable" : "") +
        (selected ? " selected" : "") +
        (fixed ? " fixed-size" : "")
      }
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(card.id, e.clientX, e.clientY);
      }}
    >
      {card.ghost && <div className="ghost-label">Claude suggests</div>}
      <div className="card-head">
        <span className={`dot dot-${card.stage}`} aria-hidden="true" />
        <span className="stage-name">{STAGE_LABEL[card.stage]}</span>
        {branchGroup(card) && <span className="fork-badge" title="Part of a fork — open the card to compare">⑂</span>}
        <button
          type="button"
          className="card-menu-btn"
          aria-label={`Card menu for ${card.title}`}
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onMenu(card.id, r.left, r.bottom + 4);
          }}
        >
          ⋯
        </button>
      </div>
      <h3>{card.title}</h3>
      {imgUrl && <img className="card-image" src={imgUrl} alt="" />}
      {url && <a className="card-clip" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{url}</a>}
      {bodyHtml && <ScrollArea className="card-body md" dangerouslySetInnerHTML={{ __html: bodyHtml }} />}
      {card.tags.length > 0 && <div className="tags">{card.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      {card.ghost && (
        <div className="ghost-actions">
          <button type="button" className="btn primary" onClick={(e) => { e.stopPropagation(); void ws.updateCard(card.id, { ghost: false }); }}>Keep</button>
          <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); void ws.deleteCard(card.id); }}>Dismiss</button>
        </div>
      )}
      {!linking &&
        HANDLES.map((d) => (
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
    </article>
  );
});

/** Right-click / ⋯ menu for a card: Open, Bring to front, Send to back. */
function CardMenu({ x, y, onClose, onOpen, onFront, onBack }: { x: number; y: number; onClose: () => void; onOpen: () => void; onFront: () => void; onBack: () => void }) {
  useEscClose(onClose);
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  const item = (label: string, fn: () => void, ref?: React.Ref<HTMLButtonElement>) => (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      ref={ref}
      onClick={() => {
        fn();
        onClose();
      }}
    >
      {label}
    </button>
  );
  // Keep the menu on screen.
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 170);
  return (
    <div
      className="menu-overlay"
      data-wheel-boundary=""
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="card-menu glass" role="menu" style={{ left, top }}>
        {item("Open", onOpen, first)}
        {item("Bring to front", onFront)}
        {item("Send to back", onBack)}
      </div>
    </div>
  );
}

function WebClipPrompt({ onClose, onCreate }: { onClose: () => void; onCreate: (url: string, title: string) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  return (
    <Modal onClose={onClose} label="Web clip" size="sm" className="clip-prompt">
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
    </Modal>
  );
}
