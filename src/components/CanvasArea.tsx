import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { api, type Card, type CardKind, type ClipAttachment, type Frame, type Pos, type ProjectData } from "../api";
import { renderMarkdown } from "../util/markdown";
import { CARD_H, CARD_W, FOLDER_H, FOLDER_W, HANDLES, cardRect, displayStack, folderRect, resizeRect, type HandleDir, type Rect } from "./cardGeometry";
import { folderChain, folderName, isInside, ROOT, type GhostLink, type Items, type Structure, type Workspace } from "../state/useWorkspace";
import { DEFAULT_FOLDER_TITLE, FolderView, previewsOf, type FolderControls } from "./Folders";
import { useTheme } from "../theme/ThemeContext";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { Layer } from "../ui/Layer";
import { freeArea } from "../ui/layout";
import { Modal } from "../ui/Modal";
import { ScrollArea, wheelBelongsToContent } from "../ui/Scroll";
import { dialogOpen } from "../util/useEscClose";
import { branchGroup } from "./BranchCompare";
import { CardEditor } from "./CardEditor";
import { MistLayer } from "./MistLayer";
import { DEFAULT_FRAME_TITLE, FRAME_PAD, FrameView, centerInside, type FrameControls } from "./Frames";
import { ChecklistBody, ClipBody, DECISIONS_TITLE, ImageBody, KIND_LABEL, TECH_TEMPLATE, TECH_TITLE, hasStage, labelSize, openQuestions, swatchOf } from "./kinds";
import { IconCard, IconChecklist, IconClip, IconFit, IconFolder, IconFrame, IconImage, IconLink, IconMerge, IconMinus, IconPin, IconPlus, IconRedo, IconSparkle, IconTrash as IconTrashCan, IconUndo } from "./Icons";
import { PromptModal, buildPrompt } from "./PromptModal";
import { ContextMenu, type MenuSection } from "./ContextMenu";
import { menuFor, type MenuEnv, type MenuTarget } from "./canvasMenus";
import { CardAttachments, ClipPopover, Lightbox, droppedUrl, imageFiles, isClip, isImage } from "./Attachments";
import { asUrl } from "../util/media";
import { TrashView } from "./TrashView";
import { ProposalView } from "./ProposalView";
import { DuskStrip, useDuskGlass } from "./DuskGlass";
import { OrganizePreviewLayer, TidyNudge } from "./OrganizePlan";
import { NewArtifactDialog } from "./artifacts/NewArtifact";
import { briefFromCard } from "./artifacts/prompts";

/** Cards loose on one canvas (outside every frame) before "Tidy this folder?" shows. */
const TIDY_NUDGE_AT = 25;

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const WHEEL_ZOOM = 0.0015;
/** Ctrl+wheel (trackpad pinch) zooms this many times faster. */
const PINCH_FACTOR = 3;
/** Right-drag starts panning only after the pointer moves this far (else it's a right-click). */
const RIGHT_PAN_SLOP = 4;
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
type Viewport = { x: number; y: number; zoom: number };
const FOCUS_ZOOM = 1.15;
/** Below this zoom the canvas gets `.far` (cheaper Reverie edge). */
const FAR_ZOOM = 0.5;

export function CanvasArea({ ws }: { ws: Workspace }) {
  const { data } = ws;
  const [filter, setFilter] = useState<Set<StageId>>(new Set(STAGES));
  const [editing, setEditing] = useState<string | null>(null);
  /** A chat link asked for another card while the editor has unsaved edits (inline confirm). */
  const [switchAsk, setSwitchAsk] = useState<string | null>(null);
  const editorDirty = useRef(false);
  // Linking lives in the workspace, so it survives opening another folder (links can cross folders).
  const { linkMode, linkFrom, setLinking } = ws;
  /** Web clip prompt: for the toolbar (centre of view), a point on the canvas, or a card. */
  const [clipPrompt, setClipPrompt] = useState<null | { at?: { x: number; y: number }; cardId?: string }>(null);
  /** Where the next picked image files go (same targets as the clip prompt). */
  const imageTarget = useRef<null | { at?: { x: number; y: number }; cardId?: string }>(null);
  /** A one-line text prompt (tag, link label, caption). */
  const [ask, setAsk] = useState<Parameters<MenuEnv["askText"]>[0] | null>(null);
  /** Add › New artifact… (at a point, or the centre of the view). */
  const [newArtifact, setNewArtifact] = useState<null | { at?: { x: number; y: number } }>(null);
  /** An attachment opened from a card on the canvas: an image in the lightbox, or a clip's popover. */
  const [viewer, setViewer] = useState<{ cardId: string; attId: string; anchor: DOMRect } | null>(null);
  const onAttachment = useCallback((cardId: string, attId: string, anchor: DOMRect) => setViewer({ cardId, attId, anchor }), []);
  const lastPointer = useRef({ x: 0, y: 0 });
  const [trashOpen, setTrashOpen] = useState(false);
  const [themePicker, setThemePicker] = useState<{ left: number; top: number } | null>(null);
  const { themes } = useTheme();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sizeRef = useRef({ w: 1200, h: 800 });
  const originRef = useRef({ x: 0, y: 0 });
  const [cameraAnim, setCameraAnim] = useState(false);
  const cameraAnimTimer = useRef<number | undefined>(undefined);
  /** The open context menu: screen position + what it is for. */
  const [ctx, setCtx] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  /** Multi-selection (Ctrl/Shift+click), for Merge. */
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [promptFor, setPromptFor] = useState<string | null>(null);
  /** Card whose pending Claude proposal is open in the diff view. */
  const [proposalFor, setProposalFor] = useState<string | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<string | null>(null);
  const [renamingFrame, setRenamingFrame] = useState<string | null>(null);
  /** Folder nodes selected on this canvas (cards stay in `selection`). */
  const [folderSel, setFolderSel] = useState<Set<string>>(new Set());
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  /** The folder node or crumb under a drag (highlighted). */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  useEffect(() => {
    setSelection(new Set());
    setSelectedFrame(null);
    setRenamingFrame(null);
    setFolderSel(new Set());
    setRenamingFolder(null);
  }, [ws.active, ws.folder]);

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
      if (p) return cardRect(p, heights.current.get(id));
      const f = data?.canvas.folders?.[id];
      return f ? folderRect(f) : undefined;
    },
    // measureTick: heights changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, measureTick],
  );

  // "Tidy this folder?": checked only when a canvas opens and when cards are added to it.
  const [tidyNudge, setTidyNudge] = useState(false);
  const canvasCards = data ? Object.keys(data.canvas.cards).length : 0;
  const lastCheck = useRef<{ key: string; n: number } | null>(null);
  useEffect(() => {
    if (!data) return;
    const key = `${data.slug}/${ws.folder ?? ""}`;
    const prev = lastCheck.current;
    lastCheck.current = { key, n: canvasCards };
    if (prev && prev.key === key && canvasCards <= prev.n) return;
    const frames = Object.values(data.canvas.frames ?? {});
    const ghosts = new Set(data.cards.filter((c) => c.ghost).map((c) => c.id));
    const loose = Object.entries(data.canvas.cards).filter(([id, p]) => !ghosts.has(id) && !frames.some((f) => centerInside(f, cardRect(p)))).length;
    setTidyNudge(loose >= TIDY_NUDGE_AT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.slug, ws.folder, canvasCards]);

  const toggle = (s: StageId) =>
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const vp = data?.canvas.viewport ?? { x: 300, y: 110, zoom: 1 };
  // The camera is applied to exactly two elements: the world's transform and the grid's background.
  // It is deliberately not an inherited custom property on the canvas: changing one of those every
  // pan frame made the browser re-resolve the styles of every card on screen (see decisions, item 4).
  const worldStyle = { transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` } as CSSProperties;
  const gridStyle = { backgroundSize: `${30 * vp.zoom}px ${30 * vp.zoom}px`, backgroundPosition: `${vp.x}px ${vp.y}px` } as CSSProperties;
  const title = data?.meta.name ?? "";

  // Only the open canvas's cards. The stage filter applies only to kind "card" (Tech included);
  // stickies, labels, checklists, images and clips always show.
  const visible = useMemo(() => (data?.cards ?? []).filter((c) => data?.canvas.cards[c.id] && (!hasStage(c) || filter.has(c.stage))), [data, filter]);
  const cardsById = useMemo(() => new Map((data?.cards ?? []).map((c) => [c.id, c])), [data]);
  /** Folder nodes on this canvas: [id, record, pos]. */
  const folderNodes = useMemo(
    () => Object.entries(data?.canvas.folders ?? {}).flatMap(([id, p]) => {
      const f = data?.folders.find((x) => x.id === id);
      return f ? [[id, f, p] as const] : [];
    }),
    [data],
  );
  const chain = useMemo(() => (data ? folderChain(data.folders, ws.folder) : []), [data, ws.folder]);

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

  // Frames are culled like cards; drawn behind them in z order (ties: larger first).
  const framesOnScreen = useMemo(() => {
    const all = Object.entries(data?.canvas.frames ?? {});
    if (!all.length) return [] as [string, Frame][];
    const margin = 400;
    const { w, h } = sizeRef.current;
    const left = (-vp.x - margin) / vp.zoom;
    const top = (-vp.y - margin) / vp.zoom;
    const right = (w - vp.x + margin) / vp.zoom;
    const bottom = (h - vp.y + margin) / vp.zoom;
    return all
      .filter(([, f]) => f.x + f.w >= left && f.x <= right && f.y + f.h >= top - 60 && f.y <= bottom)
      .sort((a, b) => a[1].z - b[1].z || b[1].w * b[1].h - a[1].w * a[1].h);
  }, [data, vp]);

  // The WebGL Mist edge runs only while a non-ghost Mist card is on screen.
  const hasMist = useMemo(() => onScreen.some((c) => hasStage(c) && c.stage !== "dream" && !c.ghost), [onScreen]);

  // Cards and folder nodes share one stacking order.
  const stack = useMemo(
    () => displayStack([...onScreen.map((c) => c.id), ...folderNodes.map(([id]) => id)], rectOf, (id) => data?.canvas.cards[id] ?? data?.canvas.folders?.[id]),
    [onScreen, folderNodes, rectOf, data],
  );

  // ----- pan / zoom -----

  // One viewport transform {x, y, zoom} drives the world (cards), the dot grid and the Mist shader
  // (which reads card boxes from the DOM). Rapid input is coalesced into one update per frame.
  const vpRef = useRef<Viewport>(vp);
  const pendingVp = useRef<Viewport | null>(null);
  const vpRaf = useRef(0);
  if (!pendingVp.current) vpRef.current = vp;
  const queueViewport = useCallback(
    (next: Viewport) => {
      pendingVp.current = next;
      vpRef.current = next;
      if (vpRaf.current) return;
      vpRaf.current = requestAnimationFrame(() => {
        vpRaf.current = 0;
        const p = pendingVp.current;
        pendingVp.current = null;
        if (p) ws.setViewport(p);
      });
    },
    [ws],
  );
  useEffect(() => () => cancelAnimationFrame(vpRaf.current), []);

  /** Zoom to `newZoom`, keeping the world point under screen (sx, sy) fixed. */
  const zoomAt = useCallback(
    (screenX: number, screenY: number, newZoom: number) => {
      const cur = vpRef.current;
      const k = clampZoom(newZoom);
      const worldX = (screenX - cur.x) / cur.zoom;
      const worldY = (screenY - cur.y) / cur.zoom;
      queueViewport({ x: screenX - worldX * k, y: screenY - worldY * k, zoom: k });
    },
    [queueViewport],
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
      const pinch = e.ctrlKey || e.metaKey;
      // Ctrl+wheel always zooms the canvas, even over a scrollable card body.
      if (!pinch && wheelBelongsToContent(t, el, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      // Cached origin: measuring here would force a synchronous style recalc on every wheel event.
      const sx = e.clientX - originRef.current.x;
      const sy = e.clientY - originRef.current.y;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomAt(sx, sy, vpRef.current.zoom * Math.exp(-dy * WHEEL_ZOOM * (pinch ? PINCH_FACTOR : 1)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ----- pointer: right/middle-drag pans, left-drag on empty canvas draws a marquee -----

  const panDrag = useRef<{
    id: number; x: number; y: number; vx: number; vy: number; started: boolean; button: number;
    cardId: string | null; frameId: string | null; folderId: string | null; link: { from: string; to: string } | null; empty: boolean;
  } | null>(null);
  const marqueeRef = useRef<{ id: number; x0: number; y0: number; base: Set<string> } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const visibleRef = useRef<Card[]>([]);
  visibleRef.current = visible;

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      const t = e.target as Element;
      const root = e.currentTarget as Element;
      if (e.button === 1 || e.button === 2) {
        // Pills, popups and ghost-link controls keep their own pointer input.
        if (t.closest?.("[data-wheel-boundary]")) return;
        if (e.button === 1) e.preventDefault(); // no autoscroll
        const cardEl = t.closest?.(".card") as HTMLElement | null;
        const folderEl = cardEl ? null : (t.closest?.("[data-folder-node]") as HTMLElement | null);
        const linkEl = cardEl ? null : (t.closest?.("[data-link-from]") as SVGElement | null);
        panDrag.current = {
          id: e.pointerId, x: e.clientX, y: e.clientY, vx: vpRef.current.x, vy: vpRef.current.y,
          started: e.button === 1, button: e.button, cardId: cardEl?.dataset.id ?? null,
          // A frame's title tab or edge handles (its body ignores the pointer).
          frameId: cardEl || folderEl ? null : ((t.closest?.("[data-frame]") as HTMLElement | null)?.dataset.frame ?? null),
          folderId: folderEl?.dataset.folderNode ?? null,
          link: linkEl ? { from: linkEl.dataset.linkFrom!, to: linkEl.dataset.linkTo! } : null,
          empty: t === root || t.classList.contains("grid"),
        };
        root.setPointerCapture(e.pointerId);
        return;
      }
      // Left presses: only on empty canvas (the canvas itself or its dot grid).
      if (e.button !== 0 || (t !== root && !t.classList.contains("grid"))) return;
      if (linkMode) {
        setLinking(false);
        return;
      }
      setSelectedFrame(null);
      const base = e.shiftKey ? new Set(selection) : new Set<string>();
      if (!e.shiftKey) {
        setSelection((s) => (s.size ? new Set() : s));
        setFolderSel((s) => (s.size ? new Set() : s));
      }
      const sx = e.clientX - originRef.current.x;
      const sy = e.clientY - originRef.current.y;
      marqueeRef.current = { id: e.pointerId, x0: sx, y0: sy, base };
      root.setPointerCapture(e.pointerId);
    },
    [linkMode, selection, setLinking],
  );
  const onBackgroundPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = panDrag.current;
      if (d && e.pointerId === d.id) {
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.started && Math.hypot(dx, dy) < RIGHT_PAN_SLOP) return;
        d.started = true;
        queueViewport({ x: d.vx + dx, y: d.vy + dy, zoom: vpRef.current.zoom });
        return;
      }
      const m = marqueeRef.current;
      if (!m || e.pointerId !== m.id) return;
      const sx = e.clientX - originRef.current.x;
      const sy = e.clientY - originRef.current.y;
      const box = { x: Math.min(m.x0, sx), y: Math.min(m.y0, sy), w: Math.abs(sx - m.x0), h: Math.abs(sy - m.y0) };
      setMarquee(box);
      const v = vpRef.current;
      const wl = (box.x - v.x) / v.zoom;
      const wt = (box.y - v.y) / v.zoom;
      const wr = wl + box.w / v.zoom;
      const wb = wt + box.h / v.zoom;
      const next = new Set(m.base);
      for (const c of visibleRef.current) {
        const r = rectOf(c.id);
        if (r && r.x <= wr && r.x + r.w >= wl && r.y <= wb && r.y + r.h >= wt) next.add(c.id);
      }
      setSelection(next);
      const fs = new Set<string>();
      for (const [id, p] of Object.entries(frameEnv.current.data?.canvas.folders ?? {})) {
        const r = folderRect(p);
        if (r.x <= wr && r.x + r.w >= wl && r.y <= wb && r.y + r.h >= wt) fs.add(id);
      }
      setFolderSel(fs);
    },
    [queueViewport, rectOf],
  );
  const onBackgroundPointerUp = useCallback((e: ReactPointerEvent) => {
    const d = panDrag.current;
    if (d && e.pointerId === d.id) {
      panDrag.current = null;
      if (d.started) void ws.flushCanvas();
      // A right-click without a drag opens the context menu for whatever is under the pointer.
      else if (d.button === 2 && e.type === "pointerup") {
        const at = { x: e.clientX, y: e.clientY };
        if (d.cardId) openCardMenuRef.current(d.cardId, at.x, at.y);
        else if (d.folderId) openFolderMenuRef.current(d.folderId, at.x, at.y);
        else if (d.frameId) {
          setSelectedFrame(d.frameId);
          setCtx({ ...at, target: { kind: "frame", id: d.frameId } });
        } else if (d.link) setCtx({ ...at, target: { kind: "link", ...d.link } });
        else if (d.empty) setCtx({ ...at, target: { kind: "canvas", point: screenToWorldRef.current(at.x, at.y) } });
      }
      return;
    }
    if (marqueeRef.current && e.pointerId === marqueeRef.current.id) {
      marqueeRef.current = null;
      setMarquee(null);
    }
  }, [ws]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      sizeRef.current = { w: el.clientWidth, h: el.clientHeight };
      const r = el.getBoundingClientRect();
      originRef.current = { x: r.left, y: r.top };
    });
    ro.observe(el);
    sizeRef.current = { w: el.clientWidth, h: el.clientHeight };
    const r = el.getBoundingClientRect();
    originRef.current = { x: r.left, y: r.top };
    return () => ro.disconnect();
  }, []);

  // Keyboard: Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y), ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While a popup is open the canvas takes no keyboard input (Esc belongs to the popup).
      if (dialogOpen()) return;
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const one = singleRef.current;
      if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
        e.preventDefault();
        keyboardMenuRef.current();
      } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && folderSelRef.current.length === 1 && !selectionRef.current.length && !target?.closest?.("button, a")) {
        e.preventDefault();
        ws.openFolder(folderSelRef.current[0]);
      } else if ((e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) || (e.altKey && e.key === "ArrowUp")) {
        if (!ws.folder) return;
        e.preventDefault();
        ws.openFolder(dataRef.current?.folders.find((f) => f.id === ws.folder)?.parent ?? null);
      } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && one && !target?.closest?.("button, a")) {
        e.preventDefault();
        openRef.current(one);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (one) duplicateRef.current(one);
      } else if (e.key.toLowerCase() === "l" && !e.ctrlKey && !e.metaKey && !e.altKey && one && !one.ghost) {
        e.preventDefault();
        setLinking(true, one.id);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(new Set(visibleRef.current.map((c) => c.id)));
        setFolderSel(new Set(Object.keys(dataRef.current?.canvas.folders ?? {})));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        wrapRef.current(selectionRef.current);
      } else if (e.key === "Delete") {
        const ids = selectionRef.current.length ? selectionRef.current : !selectedFrameRef.current && one ? [one.id] : [];
        const fids = folderSelRef.current;
        if (ids.length || fids.length) {
          e.preventDefault();
          setSelection(new Set());
          setFolderSel(new Set());
          if (ids.length) void ws.deleteCards(ids);
          void (async () => { for (const f of fids) await ws.deleteFolder(f); })();
        } else if (selectedFrameRef.current) {
          e.preventDefault();
          ws.deleteFrame(selectedFrameRef.current);
          setSelectedFrame(null);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void ws.redo();
        else void ws.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void ws.redo();
      } else if (e.key === "Escape") {
        setLinking(false);
        setSelection((s) => (s.size ? new Set() : s));
        setFolderSel((s) => (s.size ? new Set() : s));
        setSelectedFrame(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws, linkMode, setLinking]);

  // Pan/zoom to a card asked for by a search result (chat chip or Ctrl+K), then select it.
  const { focusRequest, clearFocus, setError } = ws;
  useEffect(() => {
    if (!focusRequest || !data || data.slug !== focusRequest.slug) return;
    const card = data.cards.find((c) => c.id === focusRequest.id);
    const pos = data.canvas.cards[focusRequest.id];
    clearFocus();
    // With the card editor open, a chat link retargets the editor (asking first if it has edits).
    if (editing && card && card.id !== editing) {
      if (editorDirty.current) setSwitchAsk(card.id);
      else setEditing(card.id);
    }
    if (!card || !pos) {
      setError("That card isn't on this canvas any more (it may have been trashed).");
      return;
    }
    if (hasStage(card) && !filter.has(card.stage)) setFilter((prev) => new Set(prev).add(card.stage));
    const r = cardRect(pos, heights.current.get(card.id));
    const { w, h } = sizeRef.current;
    const zoom = Math.min(MAX_ZOOM, Math.max(FOCUS_ZOOM, vp.zoom));
    const free = freeArea(w);
    const cx = free.right - free.left > 200 ? (free.left + free.right) / 2 : w / 2;
    setCameraAnim(true);
    ws.setViewport({ x: cx - (r.x + r.w / 2) * zoom, y: h / 2 - (r.y + Math.min(r.h, h / zoom - 80) / 2) * zoom, zoom });
    // Not an effect cleanup: the viewport change re-renders right away and must not cancel this.
    window.clearTimeout(cameraAnimTimer.current);
    cameraAnimTimer.current = window.setTimeout(() => setCameraAnim(false), 500);
  }, [focusRequest, data, filter, vp.zoom, ws, clearFocus, setError, editing]);

  const fit = useCallback(() => {
    // Bail out only when nothing passes the filter: "no card on screen" is exactly when Fit is needed.
    if (!data || (visible.length === 0 && folderNodes.length === 0)) {
      if (data) ws.setViewport({ x: sizeRef.current.w / 2, y: sizeRef.current.h / 2, zoom: 1 });
      return;
    }
    const pts = [...(visible.map((c) => rectOf(c.id)).filter(Boolean) as Rect[]), ...Object.values(data.canvas.frames ?? {}), ...folderNodes.map(([, , p]) => folderRect(p))];
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
  }, [data, visible, folderNodes, ws, rectOf]);

  /** New card (opened in the editor) at `at` (its top-left), or at the centre of the view. */
  const createAt = useCallback(
    async (extra: Parameters<Workspace["createCard"]>[0] = {}, at?: { x: number; y: number }) => {
      const { w, h } = sizeRef.current;
      const worldX = at?.x ?? (w / 2 - vp.x) / vp.zoom - CARD_W / 2;
      const worldY = at?.y ?? (h / 2 - vp.y) / vp.zoom - CARD_H / 2;
      const created = await ws.createCard({ title: "Untitled", x: worldX, y: worldY, ...extra });
      if (created) setEditing(created.id);
      return created;
    },
    [ws, vp],
  );

  const onCardClick = useCallback(
    (card: Card, additive?: boolean) => {
      if (additive && !linkMode) {
        setSelection((prev) => {
          const next = new Set(prev);
          // The card already open in the chat counts as the first pick.
          if (next.size === 0 && ws.contextCardId && ws.contextCardId !== card.id) next.add(ws.contextCardId);
          if (next.has(card.id)) next.delete(card.id);
          else next.add(card.id);
          return next;
        });
        return;
      }
      setSelection(new Set());
      setFolderSel((s) => (s.size ? new Set() : s));
      if (linkMode) {
        if (!linkFrom) setLinking(true, card.id);
        else if (linkFrom !== card.id) {
          ws.addLink(linkFrom, card.id);
          setLinking(false);
        }
        return;
      }
      setEditing(card.id);
      ws.setContextCard(card.id);
    },
    [linkMode, linkFrom, ws, setLinking],
  );

  /** Card menu (right-click or ⋯): the whole selection's menu when the card is part of it. */
  const openCardMenu = useCallback((id: string, x: number, y: number) => {
    const sel = selectionRef.current;
    setCtx({ x, y, target: sel.length > 1 && sel.includes(id) ? { kind: "multi", ids: sel } : { kind: "card", id } });
  }, []);
  const openCardMenuRef = useRef(openCardMenu);
  openCardMenuRef.current = openCardMenu;
  const openMenu = openCardMenu;
  const openFolderMenu = useCallback((id: string, x: number, y: number) => {
    setFolderSel((s) => (s.has(id) ? s : new Set([id])));
    setCtx({ x, y, target: { kind: "folder", id } });
  }, []);
  const openFolderMenuRef = useRef(openFolderMenu);
  openFolderMenuRef.current = openFolderMenu;

  // ----- drag into a folder (a folder node, a breadcrumb crumb, or a sidebar folder) -----

  /** The structure when the current drag started (undo of a drop goes back to it). */
  const dragBefore = useRef<Structure | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  /** The folder under (x, y) that `dragged` may go into: an id, ROOT for the project, or null. */
  const dropFolderAt = useCallback((x: number, y: number, dragged: string): string | null => {
    const d = dataRef.current;
    if (!d || x < 0) return null;
    for (const el of document.elementsFromPoint(x, y)) {
      const h = el as HTMLElement;
      if (h.closest?.(`[data-id="${dragged}"], [data-folder-node="${dragged}"], [data-frame="${dragged}"]`)) continue;
      const t = h.closest?.("[data-drop-folder]") as HTMLElement | null;
      if (!t) continue;
      const v = t.dataset.dropFolder ?? "";
      const id = v === "root" ? ROOT : v;
      if (t.dataset.dropProject && t.dataset.dropProject !== d.slug) return null;
      if (id === (ws.folder ?? ROOT)) return null;
      if (id && !d.canvases[id]) return null;
      // Never into itself or below itself.
      if (id && d.canvas.folders?.[dragged] && isInside(d.folders, id, dragged)) return null;
      return id;
    }
    return null;
  }, [ws.folder]);
  const dropRef = useRef({ dropFolderAt, ws, selection: [] as string[], folderSel: [] as string[] });
  /** What moves with a dragged thing: the whole selection when it is part of it. */
  const dragItems = (kind: "card" | "folder" | "frame", id: string): Items => {
    const { selection: sel, folderSel: fsel } = dropRef.current;
    if (kind === "frame") return { frames: [id], cards: frameCtlRef.current.members(id).map((m) => m.id) };
    const inSel = kind === "card" ? sel.includes(id) : fsel.includes(id);
    if (inSel) return { cards: sel, folders: fsel };
    return kind === "card" ? { cards: [id] } : { folders: [id] };
  };
  const dragApi = useMemo(
    () => ({
      begin: () => void (dragBefore.current = dropRef.current.ws.structure()),
      over: (x: number, y: number, id: string) => {
        const t = dropRef.current.dropFolderAt(x, y, id);
        setDropTarget((cur) => (cur === t ? cur : t));
        document.querySelectorAll(".drop-hover-ext").forEach((el) => el.classList.remove("drop-hover-ext"));
        if (t !== null) document.querySelectorAll(`[data-drop-folder="${t || "root"}"]:not([data-folder-node])`).forEach((el) => el.classList.add("drop-hover-ext"));
      },
      drop: (x: number, y: number, kind: "card" | "folder" | "frame", id: string): boolean => {
        const t = dropRef.current.dropFolderAt(x, y, id);
        setDropTarget(null);
        document.querySelectorAll(".drop-hover-ext").forEach((el) => el.classList.remove("drop-hover-ext"));
        if (t === null) return false;
        const ok = dropRef.current.ws.moveItems(dragItems(kind, id), t || null, { before: dragBefore.current });
        dragBefore.current = null;
        if (ok) {
          setSelection(new Set());
          setFolderSel(new Set());
        }
        return ok;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Stable props for CardView, so React.memo skips every card except the one that changed while
  // panning/dragging (the `ws` object itself is new on every render).
  const clickRef = useRef(onCardClick);
  clickRef.current = onCardClick;
  const onOpenCard = useCallback((c: Card, additive?: boolean) => clickRef.current(c, additive), []);
  const { moveCard, resizeCard, flushCanvas, bringToFront, updateCard, deleteCard, keepGhostCard } = ws;
  const cardActions = useMemo(
    () => ({ moveCard, resizeCard, flushCanvas, bringToFront, updateCard, deleteCard, keepGhostCard }),
    [moveCard, resizeCard, flushCanvas, bringToFront, updateCard, deleteCard, keepGhostCard],
  );
  const onPromptCard = useCallback((id: string) => setPromptFor(id), []);
  const cardDrag = useMemo(
    () => ({
      begin: dragApi.begin,
      over: dragApi.over,
      drop: (x: number, y: number, id: string) => dragApi.drop(x, y, "card", id),
      unpin: (id: string) => frameEnv.current.ws.setPinned("cards", id, false),
    }),
    [dragApi],
  );
  const onProposalCard = useCallback((id: string) => setProposalFor(id), []);
  // The chat reads the canvas selection when it sends (list_cards scope "selection").
  useEffect(() => ws.setCanvasSelection([...selection]), [ws, selection]);

  // Drop selected ids whose cards are gone (trashed, project switched).
  const liveSelection = useMemo(() => [...selection].filter((id) => data?.cards.some((c) => c.id === id)), [selection, data]);
  const selectionRef = useRef<string[]>([]);
  selectionRef.current = liveSelection;
  const liveFolderSel = useMemo(() => [...folderSel].filter((id) => data?.canvas.folders?.[id]), [folderSel, data]);
  const folderSelRef = useRef<string[]>([]);
  folderSelRef.current = liveFolderSel;
  dropRef.current = { dropFolderAt, ws, selection: liveSelection, folderSel: liveFolderSel };
  const mergeCards = useCallback((ids: string[]) => {
    const cards = ids.map((id) => data!.cards.find((c) => c.id === id)!).filter(Boolean);
    const list = cards.map((c) => `"${c.title}" (id ${c.id})`).join(", ");
    ws.requestChat({
      send: true,
      display: `Merge ${cards.length} cards`,
      text: `/merge: merge these ${cards.length} cards into one: ${list}. Read each with read_card, then call merge_cards exactly once with ids ${JSON.stringify(cards.map((c) => c.id))} and one synthesized title and markdown body.`,
    });
    setSelection(new Set());
  }, [data, ws]);
  const mergeSelected = useCallback(() => mergeCards(liveSelection), [mergeCards, liveSelection]);

  // ----- frames -----

  /** Frame around the given cards (their bounds + padding), title focused for rename. */
  const wrapInFrame = useCallback(
    (ids: string[]) => {
      const rects = ids.map((id) => rectOf(id)).filter(Boolean) as Rect[];
      if (!rects.length) return;
      const x = Math.min(...rects.map((r) => r.x)) - FRAME_PAD;
      const y = Math.min(...rects.map((r) => r.y)) - FRAME_PAD;
      const w = Math.max(...rects.map((r) => r.x + r.w)) + FRAME_PAD - x;
      const h = Math.max(...rects.map((r) => r.y + r.h)) + FRAME_PAD - y;
      const id = ws.createFrame({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, DEFAULT_FRAME_TITLE);
      if (!id) return;
      setSelection(new Set());
      setSelectedFrame(id);
      setRenamingFrame(id);
    },
    [rectOf, ws],
  );
  const wrapRef = useRef(wrapInFrame);
  wrapRef.current = wrapInFrame;
  const selectedFrameRef = useRef(selectedFrame);
  selectedFrameRef.current = selectedFrame;

  // One stable controls object for every FrameView; it reads the latest state through a ref.
  const frameEnv = useRef({ data, rectOf, ws });
  frameEnv.current = { data, rectOf, ws };
  const frameCtl = useMemo<FrameControls>(
    () => ({
      zoom: () => vpRef.current.zoom,
      members: (id) => {
        const { data: d, rectOf: ro } = frameEnv.current;
        const f = d?.canvas.frames?.[id];
        if (!d || !f) return [];
        return Object.entries(d.canvas.cards).flatMap(([cid, p]) => {
          const r = ro(cid);
          return r && !p.pinned && centerInside(f, r) ? [{ id: cid, x: p.x, y: p.y }] : [];
        });
      },
      dragOver: (x, y, id) => {
        if (!dragBefore.current) dragBefore.current = frameEnv.current.ws.structure();
        dragApi.over(x, y, id);
      },
      drop: (x, y, id) => dragApi.drop(x, y, "frame", id),
      begin: () => frameEnv.current.ws.layoutSnapshot(),
      live: (id, patch, moves) => frameEnv.current.ws.patchFrameLive(id, patch, moves),
      commit: (label, before) => {
        if (before) frameEnv.current.ws.commitLayout(label, before as NonNullable<ReturnType<Workspace["layoutSnapshot"]>>);
      },
      rename: (id, title) => frameEnv.current.ws.updateFrame(id, { title }, "rename frame"),
      select: (id) => {
        setSelectedFrame(id);
        if (id) setSelection((s) => (s.size ? new Set() : s));
      },
      setRenaming: setRenamingFrame,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const frameCtlRef = useRef(frameCtl);
  frameCtlRef.current = frameCtl;

  /** Everything inside a frame (centre inside): cards, folder nodes and smaller frames. */
  const frameContents = useCallback((id: string): Items => {
    const d = frameEnv.current.data;
    const f = d?.canvas.frames?.[id];
    if (!d || !f) return {};
    return {
      cards: Object.keys(d.canvas.cards).filter((cid) => {
        const r = frameEnv.current.rectOf(cid);
        return r && centerInside(f, r);
      }),
      folders: Object.entries(d.canvas.folders ?? {}).filter(([, p]) => centerInside(f, folderRect(p))).map(([fid]) => fid),
      frames: Object.entries(d.canvas.frames ?? {}).filter(([k, o]) => k !== id && centerInside(f, o) && o.w * o.h < f.w * f.h).map(([k]) => k),
    };
  }, []);

  const folderCtl = useMemo<FolderControls>(
    () => ({
      zoom: () => vpRef.current.zoom,
      begin: () => {
        dragBefore.current = frameEnv.current.ws.structure();
        return frameEnv.current.ws.layoutSnapshot();
      },
      live: (id, patch) => frameEnv.current.ws.patchFolderLive(id, patch),
      commit: (label, before) => {
        dragBefore.current = null;
        if (before) frameEnv.current.ws.commitLayout(label, before as NonNullable<ReturnType<Workspace["layoutSnapshot"]>>);
      },
      dragOver: (x, y, id) => dragApi.over(x, y, id),
      drop: (x, y, id) => dragApi.drop(x, y, "folder", id),
      click: (id, additive) => {
        setSelectedFrame(null);
        if (!additive) setSelection((s) => (s.size ? new Set() : s));
        setFolderSel((s) => {
          if (!additive) return new Set([id]);
          const n = new Set(s);
          if (n.has(id)) n.delete(id);
          else n.add(id);
          return n;
        });
      },
      open: (id) => frameEnv.current.ws.openFolder(id),
      menu: (id, x, y) => openFolderMenuRef.current(id, x, y),
      front: (id) => frameEnv.current.ws.setFolderStacking(id, "front"),
      rename: (id, title) => frameEnv.current.ws.updateFolder(id, { title }, "rename folder"),
      setRenaming: setRenamingFolder,
      unpin: (id) => frameEnv.current.ws.setPinned("folders", id, false),
    }),
    [dragApi],
  );

  /** New folder: at a world point, or around the given items (they move inside). Name field focused. */
  const newFolder = useCallback(
    (at: { x: number; y: number } | null, group?: Items) => {
      const id = ws.createFolder(at, DEFAULT_FOLDER_TITLE, group);
      if (!id) return;
      setSelection(new Set());
      setFolderSel(new Set([id]));
      setRenamingFolder(id);
    },
    [ws],
  );

  /** New sticky / label / checklist / Tech card at the centre of the view. */
  const addKind = useCallback(
    async (kind: CardKind | "tech", at?: { x: number; y: number }) => {
      if (kind === "tech") {
        const existing = data?.cards.find((c) => c.role === "tech");
        if (existing) {
          void ws.focusCard(existing.id);
          return;
        }
        await createAt({ title: TECH_TITLE, role: "tech", body: TECH_TEMPLATE }, at);
        return;
      }
      const titles: Partial<Record<CardKind, string>> = { sticky: "Note", label: "Heading", checklist: "Checklist" };
      await createAt({ kind, title: titles[kind] ?? "Untitled", ...(kind === "sticky" ? { color: "butter" } : {}) }, at);
    },
    [data, ws, createAt],
  );
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);

  /** World position for a screen point (top-left of a card centred there). */
  const worldAt = useCallback(
    (clientX: number, clientY: number) => {
      const rect = rootRef.current!.getBoundingClientRect();
      return { x: (clientX - rect.left - vp.x) / vp.zoom - CARD_W / 2, y: (clientY - rect.top - vp.y) / vp.zoom - CARD_H / 2 };
    },
    [vp],
  );

  /**
   * Images or a link dropped/pasted at a screen point: onto a card they're added to it; on empty
   * canvas they make a new card (all dropped images, or the fetched clip).
   */
  const addAt = useCallback(
    async (clientX: number, clientY: number, files: File[], url: string | null, target: Element | null) => {
      if (!files.length && !url) return;
      const cardId = (target?.closest(".card[data-id]") as HTMLElement | null)?.dataset.id;
      if (cardId && data?.cards.some((c) => c.id === cardId)) {
        if (files.length) await ws.addImages(cardId, files);
        else if (url) {
          ws.toast("Fetching the page…");
          const clip = await ws.addClip(cardId, url);
          ws.toast(clip?.fetch_error ? `Added the link (couldn't fetch the page: ${clip.fetch_error})` : null);
        }
        return;
      }
      const at = worldAt(clientX, clientY);
      if (files.length) {
        const created = await ws.createCard({ title: files[0].name.replace(/\.[^.]+$/, "") || "Image", ...at });
        if (created) await ws.addImages(created.id, files);
      } else if (url && ws.active) {
        ws.toast("Fetching the page…");
        const clip = await api.fetchClip(ws.active, url).catch(() => null);
        ws.toast(null);
        await ws.createCard({ title: clip?.title || url, ...at, attachments: clip ? [clip] : [] });
      }
    },
    [ws, data, worldAt],
  );

  const onDropFile = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const files = imageFiles(e.dataTransfer.files);
      await addAt(e.clientX, e.clientY, files, files.length ? null : droppedUrl(e.dataTransfer), e.target as Element);
    },
    [addAt],
  );

  // Paste on the canvas (nothing focused, no popup): onto the card under the pointer, else a new card there.
  const addAtRef = useRef(addAt);
  addAtRef.current = addAt;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (dialogOpen() || !rootRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      const files = imageFiles(e.clipboardData?.items);
      const url = files.length ? null : asUrl(e.clipboardData?.getData("text/plain"));
      if (!files.length && !url) return;
      const { x, y } = lastPointer.current;
      const r = rootRef.current.getBoundingClientRect();
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      const px = inside ? x : r.left + r.width / 2;
      const py = inside ? y : r.top + r.height / 2;
      e.preventDefault();
      void addAtRef.current(px, py, files, url, inside ? document.elementFromPoint(px, py) : null);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // ----- context menus -----

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const r = rootRef.current!.getBoundingClientRect();
    const v = vpRef.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }, []);
  const screenToWorldRef = useRef(screenToWorld);
  screenToWorldRef.current = screenToWorld;

  /** The one card keyboard shortcuts act on: the single selected card, else the open (highlighted) one. */
  const single = useMemo(() => {
    const id = liveSelection.length === 1 ? liveSelection[0] : liveSelection.length === 0 ? ws.contextCardId : null;
    return (id && data?.cards.find((c) => c.id === id)) || null;
  }, [liveSelection, ws.contextCardId, data]);
  const singleRef = useRef(single);
  singleRef.current = single;

  const openEditor = useCallback(
    (c: Card) => {
      setSelection(new Set());
      setEditing(c.id);
      ws.setContextCard(c.id);
    },
    [ws],
  );
  /** Open: the editor, or for an image / clip object its lightbox / popover. */
  const openCard = useCallback(
    (c: Card) => {
      const att = c.ghost ? undefined : c.kind === "image" ? c.attachments.find(isImage) : c.kind === "clip" ? c.attachments.find(isClip) : undefined;
      const el = document.querySelector(`.card[data-id="${c.id}"]`);
      if (att && el) setViewer({ cardId: c.id, attId: att.id, anchor: el.getBoundingClientRect() });
      else openEditor(c);
    },
    [openEditor],
  );
  const openRef = useRef(openCard);
  openRef.current = openCard;

  /** Duplicate (same place +24px) or Branch (to the right, as a fork of the original). One undo step. */
  const copyCard = useCallback(
    async (c: Card, how: "duplicate" | "branch") => {
      const p = data?.canvas.cards[c.id];
      if (!p) return;
      const r = rectOf(c.id);
      const at = how === "branch" && r ? { x: r.x + r.w + 40, y: r.y } : { x: p.x + 24, y: p.y + 24 };
      const created = await ws.createCard({
        title: how === "branch" ? `${c.title} (branch)` : c.title,
        body: c.body,
        stage: c.stage,
        tags: c.tags,
        fields: c.fields,
        kind: c.kind,
        color: c.color,
        items: c.items,
        attachments: c.attachments.map((a, i) => ({ ...a, id: `a${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}` })),
        links: c.links,
        ...(how === "branch" ? { branch: { group: branchGroup(c) ?? crypto.randomUUID(), of: c.id } } : {}),
        ...at,
      });
      if (!created) return;
      // Same size as the original (no extra undo step: undoing the create removes the card anyway).
      if (p.w !== undefined && p.h !== undefined) ws.resizeCard(created.id, { ...at, w: p.w, h: p.h });
      setSelection(new Set([created.id]));
    },
    [data, rectOf, ws],
  );
  const duplicateRef = useRef((c: Card) => void copyCard(c, "duplicate"));
  duplicateRef.current = (c: Card) => void copyCard(c, "duplicate");

  /** Paste from the context menu: image → image object, URL → clip object, text → card. */
  const pasteAt = useCallback(
    async (point: { x: number; y: number }) => {
      const at = { x: point.x - CARD_W / 2, y: point.y - CARD_H / 2 };
      let image: Blob | null = null;
      let text = "";
      try {
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            image = await item.getType(type);
            break;
          }
          if (!text && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
        }
      } catch {
        text = await navigator.clipboard.readText().catch(() => "");
      }
      if (image) {
        const atts = await ws.saveImages([image]).catch((e) => {
          ws.setError(String(e));
          return [];
        });
        if (atts.length) await ws.createCard({ kind: "image", title: "Pasted image", attachments: atts, ...at });
        return;
      }
      const url = asUrl(text);
      if (url && ws.active) {
        ws.toast("Fetching the page…");
        const clip = await api.fetchClip(ws.active, url).catch((): ClipAttachment => ({ id: `a${Date.now().toString(36)}`, type: "clip", url }));
        ws.toast(null);
        await ws.createCard({ kind: "clip", title: clip.title || url, attachments: [clip], ...at });
        return;
      }
      const t = text.trim();
      if (!t) {
        ws.toast("There's nothing to paste.");
        return;
      }
      const [first, ...rest] = t.split("\n");
      const short = first.length <= 80;
      await ws.createCard({ title: short ? first.trim() : `${first.slice(0, 77).trimEnd()}…`, body: short ? rest.join("\n").trim() : t, ...at });
    },
    [ws],
  );

  /** Shift+F10 / Menu key: the menu for the selection, the open card, the selected frame, or the canvas. */
  const keyboardMenu = () => {
    const root = rootRef.current;
    if (!root || !data) return;
    const rectOfEl = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const sel = selectionRef.current;
    const near = (r: DOMRect | undefined) => (r ? { x: r.left + 16, y: r.top + 16 } : { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    if (sel.length > 1) setCtx({ ...near(rectOfEl(`.card[data-id="${sel[sel.length - 1]}"]`)), target: { kind: "multi", ids: sel } });
    else if (single) setCtx({ ...near(rectOfEl(`.card[data-id="${single.id}"]`)), target: { kind: "card", id: single.id } });
    else if (selectedFrame) setCtx({ ...near(rectOfEl(`[data-frame="${selectedFrame}"] .frame-tab`)), target: { kind: "frame", id: selectedFrame } });
    else {
      const p = near(undefined);
      setCtx({ ...p, target: { kind: "canvas", point: screenToWorld(p.x, p.y) } });
    }
  };
  const keyboardMenuRef = useRef(keyboardMenu);
  keyboardMenuRef.current = keyboardMenu;

  const menuEnv = (): MenuEnv => ({
    ws,
    data: data!,
    rectOf,
    open: openCard,
    openEditor,
    addAt: (what, point) => {
      const at = { x: point.x - CARD_W / 2, y: point.y - CARD_H / 2 };
      if (what === "frame") {
        const id = ws.createFrame({ x: Math.round(point.x - 240), y: Math.round(point.y - 160), w: 480, h: 320 }, DEFAULT_FRAME_TITLE);
        if (id) {
          setSelectedFrame(id);
          setRenamingFrame(id);
        }
      } else if (what === "questions") void createAt({ kind: "checklist", title: "Open questions", items: [{ id: "", text: "", done: false, question: true }] }, at);
      else void addKind(what, at);
    },
    pickImages: (t) => {
      imageTarget.current = "cardId" in t ? { cardId: t.cardId } : { at: t.point };
      fileInputRef.current?.click();
    },
    promptClip: (t) => setClipPrompt("cardId" in t ? { cardId: t.cardId } : { at: t.point }),
    paste: (p) => void pasteAt(p),
    askText: setAsk,
    visualize: (c, type) => {
      const pos = data?.canvas.cards[c.id];
      void ws.createArtifact({ type, title: c.title, brief: briefFromCard(c, type), sourceCard: c.id, ...(pos ? { x: pos.x + (pos.w ?? CARD_W) + 60, y: pos.y } : {}) });
    },
    newArtifact: (point) => setNewArtifact({ at: { x: point.x - CARD_W / 2, y: point.y - CARD_H / 2 } }),
    openArtifact: (id) => ws.setContextCard(id),
    selectAll: () => {
      setSelection(new Set(visibleRef.current.map((c) => c.id)));
      setFolderSel(new Set(Object.keys(data?.canvas.folders ?? {})));
    },
    select: (ids) => {
      setSelectedFrame(null);
      setSelection(new Set(ids));
    },
    fit,
    zoomTo100: () => zoomAt(ctx ? ctx.x - originRef.current.x : sizeRef.current.w / 2, ctx ? ctx.y - originRef.current.y : sizeRef.current.h / 2, 1),
    askClaude: (thread, text, o) => {
      ws.setContextCard(thread);
      ws.requestChat({ text, thread, send: !o?.prefill, display: o?.display });
    },
    startLink: (id) => {
      setSelection(new Set());
      setLinking(true, id);
    },
    duplicate: (c) => void copyCard(c, "duplicate"),
    branch: (c) => void copyCard(c, "branch"),
    copyPrompt: (c) =>
      void navigator.clipboard.writeText(buildPrompt(c, data!.cards, "Develop")).then(
        () => ws.toast("Prompt copied to the clipboard."),
        (e) => ws.setError(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`),
      ),
    wrap: wrapInFrame,
    merge: mergeCards,
    deleteCards: (ids) => {
      setSelection(new Set());
      if (editing && ids.includes(editing)) setEditing(null);
      void ws.deleteCards(ids);
    },
    frameMembers: (id) => frameCtl.members(id).map((m) => m.id),
    renameFrame: (id) => {
      setSelectedFrame(id);
      setRenamingFrame(id);
    },
    clearFrameSelection: () => setSelectedFrame(null),
    newFolder: (point) => newFolder({ x: Math.round(point.x - FOLDER_W / 2), y: Math.round(point.y - FOLDER_H / 2) }),
    groupIntoFolder: (items) => newFolder(null, items),
    frameContents,
    renameFolder: (id) => {
      setFolderSel(new Set([id]));
      setRenamingFolder(id);
    },
    folderSelection: liveFolderSel,
  });

  const addMenuSections: MenuSection[] = [
    {
      items: [
        { label: "Sticky note", run: () => void addKind("sticky") },
        { label: "Label (heading)", run: () => void addKind("label") },
        { label: "Checklist", run: () => void addKind("checklist") },
        { label: data?.cards.some((c) => c.role === "tech") ? "Tech & constraints (open)" : "Tech & constraints", run: () => void addKind("tech") },
      ],
    },
    { items: [{ label: "New artifact…", run: () => setNewArtifact({}) }] },
  ];

  const editingCard = data?.cards.find((c) => c.id === editing) ?? null;

  return (
    <main
      ref={rootRef}
      className={"canvas" + (cameraAnim ? " camera-anim" : "") + (vp.zoom < FAR_ZOOM ? " far" : "")}
      aria-label="Canvas"
      data-zoom={vp.zoom}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
      onPointerCancel={onBackgroundPointerUp}
      onLostPointerCapture={onBackgroundPointerUp}
      onContextMenu={(e) => {
        // No native menu on the canvas; a right-click on a card opens its menu on pointer-up.
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
      }}
      onPointerMoveCapture={(e) => {
        lastPointer.current.x = e.clientX;
        lastPointer.current.y = e.clientY;
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDropFile(e)}
    >
      <div className="grid" style={gridStyle} />
      <MistLayer rootRef={rootRef} active={hasMist} />
      <div className="world" style={worldStyle}>
        {framesOnScreen.length > 0 && (
          <div className="frames-layer">
            {framesOnScreen.map(([id, f]) => (
              <FrameView key={id} id={id} frame={f} selected={selectedFrame === id} renaming={renamingFrame === id} ctl={frameCtl} />
            ))}
          </div>
        )}
        {data && <LinkLayer cards={onScreen} rectOf={rectOf} ghosts={ws.ghostLinks} />}
        {data && <CrossLinks cards={onScreen} all={cardsById} data={data} rectOf={rectOf} ws={ws} />}
        {/* Cards get their own stacking context, so card z-order never covers ghost-link controls. */}
        <div className="cards-layer">
          {data &&
            folderNodes.map(([id, f, p]) => {
              const inner = data.canvases[id];
              const kids = Object.keys(inner?.cards ?? {}).map((cid) => cardsById.get(cid)).filter((c): c is Card => !!c && !c.ghost);
              return (
                <FolderView
                  key={id}
                  id={id}
                  folder={f}
                  pos={p}
                  z={stack.get(id) ?? 0}
                  selected={folderSel.has(id)}
                  renaming={renamingFolder === id}
                  dropHint={dropTarget === id}
                  cards={kids.length}
                  folders={Object.keys(inner?.folders ?? {}).length}
                  previews={previewsOf(kids)}
                  slug={ws.active}
                  ctl={folderCtl}
                />
              );
            })}
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
                selected={selection.size ? selection.has(c.id) : ws.contextCardId === c.id}
                onOpen={onOpenCard}
                onPrompt={onPromptCard}
                proposed={!!data.proposals?.[c.id]}
                onProposal={onProposalCard}
                onMenu={openMenu}
                onMeasure={onMeasure}
                onAttachment={onAttachment}
                drag={cardDrag}
              />
            ))}
        </div>
        {data && <GhostLinkControls cards={onScreen} rectOf={rectOf} ghosts={ws.ghostLinks} ws={ws} />}
        {data && <OrganizePreviewLayer ws={ws} rectOf={rectOf} />}
      </div>
      {data && tidyNudge && !(ws.folder ? data.folders.find((f) => f.id === ws.folder)?.nudge_off : data.meta.nudge_off) && (
        <TidyNudge
          onTidy={() => {
            setTidyNudge(false);
            ws.requestChat({ text: ws.folder ? "/organize" : "/organize project", send: true });
          }}
          onClose={() => {
            setTidyNudge(false);
            void ws.setNudgeOff(ws.folder);
          }}
        />
      )}
      {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}

      {data && ws.folder && Object.keys(data.canvas.cards).length === 0 && folderNodes.length === 0 && (
        <div className="empty">
          <div className="empty-title">An empty folder</div>
          <p>Add a card here, or drag cards onto this folder from the canvas or the sidebar. Backspace goes back up.</p>
        </div>
      )}
      {data && !ws.folder && data.cards.length === 0 && folderNodes.length === 0 && (
        <div className="empty">
          <div className="empty-title">{data.is_inbox ? "Your Inbox is empty" : "A blank canvas"}</div>
          <p>
            {data.is_inbox
              ? "Raw ideas land here. Capture one with the Card button, or press the global hotkey from anywhere."
              : "Add your first card with the Card button below."}
          </p>
        </div>
      )}
      {data && Object.keys(data.canvas.cards).length > 0 && visible.length === 0 && (
        <div className="empty">
          <div className="empty-title">No cards in this filter</div>
          <p>Turn a stage back on above to see the rest of this canvas.</p>
        </div>
      )}

      <div className="pill title-pill" data-wheel-boundary="">
        <nav className="crumbs" aria-label="Folder path">
          <button
            type="button"
            className={"crumb" + (chain.length ? "" : " here") + (dropTarget === ROOT ? " drop-hover" : "")}
            data-drop-folder="root"
            aria-current={chain.length ? undefined : "page"}
            title={chain.length ? "Back to the project (Backspace goes up one level)" : undefined}
            onClick={() => ws.openFolder(null)}
          >
            <span className="proj-title">{title || "…"}</span>
          </button>
          {chain.map((f, i) => (
            <span key={f.id} className="crumb-wrap">
              <span className="crumb-sep" aria-hidden="true">›</span>
              <button
                type="button"
                className={"crumb" + (i === chain.length - 1 ? " here" : "") + (dropTarget === f.id ? " drop-hover" : "")}
                data-drop-folder={f.id}
                aria-current={i === chain.length - 1 ? "page" : undefined}
                onClick={() => ws.openFolder(f.id)}
              >
                <IconFolder />
                {folderName(f)}
              </button>
            </span>
          ))}
        </nav>
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
        {/* aria-disabled (not disabled) so the tooltip still shows when there's nothing to undo. */}
        <button
          type="button"
          className="icon-btn history-btn"
          aria-label="Undo"
          aria-keyshortcuts="Control+Z"
          aria-disabled={!ws.canUndo}
          title={ws.canUndo ? "Undo (Ctrl+Z)" : "Undo (Ctrl+Z): nothing to undo"}
          onClick={() => ws.canUndo && void ws.undo()}
        >
          <IconUndo />
        </button>
        <button
          type="button"
          className="icon-btn history-btn"
          aria-label="Redo"
          aria-keyshortcuts="Control+Shift+Z"
          aria-disabled={!ws.canRedo}
          title={ws.canRedo ? "Redo (Ctrl+Shift+Z)" : "Redo (Ctrl+Shift+Z): nothing to redo"}
          onClick={() => ws.canRedo && void ws.redo()}
        >
          <IconRedo />
        </button>
        {data && <SuggestionsPill data={data} ws={ws} />}
        {data && !data.is_inbox && (
          <div className="theme-picker">
            <button
              type="button"
              className="chip"
              aria-expanded={!!themePicker}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setThemePicker({ left: r.left, top: r.bottom + 6 });
              }}
            >
              Theme: {themes.find((t) => t.id === data.meta.theme)?.name ?? "Workspace default"}
            </button>
            {themePicker && (
              <Layer onClose={() => setThemePicker(null)}>
                <ScrollArea boundary className="theme-picker-pop glass" style={{ left: themePicker.left, top: themePicker.top }} role="menu" aria-label="Project theme">
                  <button type="button" role="menuitem" className="theme-picker-row" onClick={() => { void ws.setProjectTheme(null); setThemePicker(null); }}>
                    Workspace default
                  </button>
                  {themes.map((t) => (
                    <button key={t.id} type="button" role="menuitem" className="theme-picker-row" onClick={() => { void ws.setProjectTheme(t.id); setThemePicker(null); }}>
                      {t.name}
                    </button>
                  ))}
                </ScrollArea>
              </Layer>
            )}
          </div>
        )}
      </div>

      {data && data.warnings.length > 0 && <Warnings data={data} />}

      {/* Bottom bar: zoom pill and Add toolbar in one grid spanning the free canvas area, so they can
          never overlap. Below ~680px of bar width the tool labels collapse to icons (container
          query in styles.css); every tool keeps an aria-label and a tooltip either way. */}
      <div className="bottom-bar">
      <div className="pill zoom-pill" role="group" aria-label="Zoom" data-wheel-boundary="">
        <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, vp.zoom / 1.2)}><IconMinus /></button>
        <span className="zoom-val" aria-live="polite">{Math.round(vp.zoom * 100)}%</span>
        <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, vp.zoom * 1.2)}><IconPlus /></button>
        <button type="button" className="icon-btn" aria-label="Fit to content" title="Fit to content" onClick={fit}><IconFit /></button>
      </div>

      <div className="pill toolbar" role="toolbar" aria-label="Add" data-wheel-boundary="">
        <button type="button" className="tool" aria-label="Add a card" title="Add a card" disabled={!data} onClick={() => void createAt()}>
          <IconCard />
          <span>Card</span>
        </button>
        <button
          type="button"
          className="tool"
          aria-label="Add a sticky, label, checklist or Tech card"
          aria-haspopup="menu"
          aria-expanded={!!addMenu}
          title="Sticky, label, checklist, Tech & constraints"
          disabled={!data}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAddMenu({ x: r.left, y: r.top });
          }}
        >
          <IconPlus />
          <span>More</span>
        </button>
        <button
          type="button"
          className={"tool" + (linkMode ? " on" : "")}
          aria-label={linkMode ? "Linking: pick two cards" : "Link two cards"}
          aria-pressed={linkMode}
          title={linkMode ? "Pick two cards… Open another folder (sidebar) or press Ctrl+K to reach a card elsewhere. Esc cancels." : "Link two cards"}
          disabled={!data}
          onClick={() => setLinking(!linkMode)}
        >
          <IconLink />
          <span>{linkMode ? "Pick two cards…" : "Link"}</span>
        </button>
        <button type="button" className="tool" aria-label="Add an image" title="Add an image" disabled={!data} onClick={() => { imageTarget.current = null; fileInputRef.current?.click(); }}>
          <IconImage />
          <span>Image</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={async (e) => {
            const files = imageFiles(e.target.files);
            e.target.value = "";
            const target = imageTarget.current;
            imageTarget.current = null;
            if (!files.length) return;
            if (target?.cardId) {
              await ws.addImages(target.cardId, files);
              return;
            }
            if (target?.at) {
              // One image object per file, each one undo step (file saved first, then the card).
              const atts = await ws.saveImages(files).catch((err) => {
                ws.setError(String(err));
                return [];
              });
              for (let i = 0; i < atts.length; i++) {
                const name = files[i]?.name.replace(/\.[^.]+$/, "") || "Image";
                await ws.createCard({ kind: "image", title: name, attachments: [atts[i]], x: target.at.x - CARD_W / 2 + i * 24, y: target.at.y - CARD_H / 2 + i * 24 });
              }
              return;
            }
            const created = await createAt({ title: files[0].name.replace(/\.[^.]+$/, "") || "Image" });
            if (created) await ws.addImages(created.id, files);
          }}
        />
        <button type="button" className="tool" aria-label="Add a web clip" title="Add a web clip" disabled={!data} onClick={() => setClipPrompt({})}>
          <IconClip />
          <span>Web clip</span>
        </button>
        {liveSelection.length >= 1 && (
          <button type="button" className="tool" aria-label="Wrap the selection in a frame" aria-keyshortcuts="Control+G" title="Wrap in frame (Ctrl+G)" onClick={() => wrapInFrame(liveSelection)}>
            <IconFrame />
            <span>Frame</span>
          </button>
        )}
        {liveSelection.length + liveFolderSel.length >= 1 && (
          <button type="button" className="tool" aria-label="Group the selection into a folder" title="Group into folder" onClick={() => newFolder(null, { cards: liveSelection, folders: liveFolderSel })}>
            <IconFolder />
            <span>Folder</span>
          </button>
        )}
        {liveSelection.length >= 2 && (
          <button type="button" className="tool on" aria-label={`Merge ${liveSelection.length} cards with Claude`} title={`Merge ${liveSelection.length} selected cards into one (Claude proposes it)`} onClick={mergeSelected}>
            <IconMerge />
            <span>Merge {liveSelection.length}</span>
          </button>
        )}
        <button type="button" className="tool" aria-label="Open the trash" title="Open the trash" disabled={!data} onClick={() => setTrashOpen(true)}>
          <IconTrashCan />
          <span>Trash</span>
        </button>
      </div>
      </div>

      {clipPrompt && (
        <WebClipPrompt
          slug={ws.active}
          onClose={() => setClipPrompt(null)}
          onCreate={(raw, name) => {
            const clip = raw.id ? raw : { ...raw, id: `a${Date.now().toString(36)}` };
            const title = name || clip.title || clip.url;
            const card = clipPrompt.cardId ? data?.cards.find((c) => c.id === clipPrompt.cardId) : undefined;
            if (card) void ws.setAttachments(card.id, [...card.attachments, clip]);
            else if (clipPrompt.at) void ws.createCard({ kind: "clip", title, attachments: [clip], x: clipPrompt.at.x - CARD_W / 2, y: clipPrompt.at.y - CARD_H / 2 });
            else void createAt({ title, attachments: [clip] });
          }}
        />
      )}
      {viewer && (() => {
        const c = data?.cards.find((x) => x.id === viewer.cardId);
        const a = c?.attachments.find((x) => x.id === viewer.attId);
        if (!c || !a) return null;
        return a.type === "image" ? (
          <Lightbox card={c} startId={a.id} slug={ws.active} onClose={() => setViewer(null)} />
        ) : (
          <ClipPopover card={c} clip={a} slug={ws.active} anchor={viewer.anchor} ws={ws} onClose={() => setViewer(null)} />
        );
      })()}
      {ctx && data && (() => {
        const m = menuFor(ctx.target, menuEnv());
        return m ? <ContextMenu key={`${ctx.x},${ctx.y}`} x={ctx.x} y={ctx.y} label={m.label} sections={m.sections} onClose={() => setCtx(null)} /> : null;
      })()}
      {addMenu && <ContextMenu x={addMenu.x} y={addMenu.y} label="Add" sections={addMenuSections} onClose={() => setAddMenu(null)} />}
      {ask && <AskText {...ask} onClose={() => setAsk(null)} />}
      {newArtifact && (
        <NewArtifactDialog
          onClose={() => setNewArtifact(null)}
          onCreate={(type, title, brief) => {
            const { w, h } = sizeRef.current;
            const at = newArtifact.at ?? { x: (w / 2 - vp.x) / vp.zoom - CARD_W / 2, y: (h / 2 - vp.y) / vp.zoom - CARD_H / 2 };
            void ws.createArtifact({ type, title: title || undefined, brief, ...at });
          }}
        />
      )}
      {editingCard && (
        <CardEditor
          key={editingCard.id}
          card={editingCard}
          ws={ws}
          onClose={() => { setEditing(null); setSwitchAsk(null); }}
          dirtyRef={editorDirty}
          switchTo={switchAsk && switchAsk !== editingCard.id ? { id: switchAsk, title: data?.cards.find((c) => c.id === switchAsk)?.title ?? "" } : null}
          onSwitch={(id) => { setSwitchAsk(null); setEditing(id); }}
          onStay={() => setSwitchAsk(null)}
        />
      )}
      {trashOpen && <TrashView ws={ws} onClose={() => setTrashOpen(false)} />}
      {proposalFor && data?.proposals?.[proposalFor] && data.cards.some((c) => c.id === proposalFor) && (
        <ProposalView card={data.cards.find((c) => c.id === proposalFor)!} proposal={data.proposals[proposalFor]} ws={ws} onClose={() => setProposalFor(null)} />
      )}
      {promptFor && data?.cards.some((c) => c.id === promptFor) && (
        <PromptModal card={data.cards.find((c) => c.id === promptFor)!} cards={data.cards} ws={ws} onClose={() => setPromptFor(null)} />
      )}
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
  const lines: { x1: number; y1: number; x2: number; y2: number; label?: string; key: string; from: string; to: string }[] = [];
  for (const c of cards) {
    const from = rectOf(c.id);
    if (!from) continue;
    for (const l of c.links) {
      const to = rectOf(l.to);
      if (!to || !byId.has(l.to)) continue;
      const a = center(from);
      const b = center(to);
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, label: l.label, key: `${c.id}-${l.to}`, from: c.id, to: l.to });
    }
  }
  if (lines.length === 0 && ghostLines.length === 0) return null;
  const pad = 4000;
  return (
    <svg className="link-layer" width={pad * 2} height={pad * 2} style={{ left: -pad, top: -pad }}>
      <g transform={`translate(${pad},${pad})`}>
        {lines.map((l) => (
          <g key={l.key} className="link">
            <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="link-line" />
            {/* Wide invisible stroke: makes the line easy to right-click. */}
            <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="link-hit" data-link-from={l.from} data-link-to={l.to} />
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

/** Stub length of a link to a card in another folder. */
const STUB = 60;

/**
 * Links between a card here and a card in another folder: a short stub from the card ending in a
 * pill "<title> · <folder>". Clicking the pill opens that folder and focuses the card.
 */
function CrossLinks({ cards, all, data, rectOf, ws }: { cards: Card[]; all: Map<string, Card>; data: ProjectData; rectOf: RectOf; ws: Workspace }) {
  const here = data.canvas.cards;
  const where = (id: string) => Object.entries(data.canvases).find(([, c]) => c.cards[id])?.[0];
  const stubs: { key: string; x1: number; y1: number; x2: number; y2: number; other: Card; folder: string }[] = [];
  // Links into this canvas from cards elsewhere, by target.
  const incoming = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const o of all.values()) if (!here[o.id]) for (const l of o.links) if (here[l.to]) m.set(l.to, [...(m.get(l.to) ?? []), o.id]);
    return m;
  }, [all, here]);
  for (const c of cards) {
    const r = rectOf(c.id);
    if (!r) continue;
    const others = new Set<string>(incoming.get(c.id) ?? []);
    for (const l of c.links) if (!here[l.to] && all.has(l.to)) others.add(l.to);
    [...others].forEach((oid, i) => {
      const k = where(oid);
      if (k === undefined) return;
      const y = r.y + 18 + i * 30;
      const x1 = r.x + r.w;
      stubs.push({ key: `${c.id}~${oid}`, x1, y1: y, x2: x1 + STUB, y2: y, other: all.get(oid)!, folder: k === ROOT ? data.meta.name : folderName(data.folders.find((f) => f.id === k)) });
    });
  }
  if (!stubs.length) return null;
  return (
    <>
      <svg className="link-layer" width={1} height={1} style={{ left: 0, top: 0, overflow: "visible" }}>
        {stubs.map((s) => (
          <line key={s.key} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className="link-line link-stub" />
        ))}
      </svg>
      {stubs.map((s) => (
        <button
          key={s.key}
          type="button"
          className="link-stub-pill"
          data-wheel-boundary=""
          style={{ left: s.x2, top: s.y2 }}
          title={`Linked card in ${s.folder}. Click to go there`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void ws.focusCard(s.other.id)}
        >
          <span className="stub-title">{s.other.title || "Untitled"}</span> · {s.folder}
        </button>
      ))}
    </>
  );
}

type CardActions = Pick<Workspace, "moveCard" | "resizeCard" | "flushCanvas" | "bringToFront" | "updateCard" | "deleteCard" | "keepGhostCard">;
/** Drag into a folder: start, hover (highlight), release (true = moved into a folder). */
type CardDrag = { begin: () => void; over: (x: number, y: number, id: string) => void; drop: (x: number, y: number, id: string) => boolean; unpin: (id: string) => void };

const currentZoom = () => Number((document.querySelector(".canvas") as HTMLElement | null)?.dataset.zoom) || 1;

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
  onPrompt,
  proposed,
  onProposal,
  onMenu,
  onMeasure,
  onAttachment,
  drag,
}: {
  card: Card;
  pos?: Pos;
  z: number;
  active: string | null;
  actions: CardActions;
  linking: boolean;
  isLinkSource: boolean;
  selected: boolean;
  onOpen: (card: Card, additive?: boolean) => void;
  onPrompt: (id: string) => void;
  /** A Claude edit proposal is pending for this card. */
  proposed: boolean;
  onProposal: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onMeasure: (id: string, h: number) => void;
  onAttachment: (cardId: string, attId: string, anchor: DOMRect) => void;
  drag: CardDrag;
}) {
  const elRef = useRef<HTMLElement | null>(null);

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
  // A ghost (Claude's suggested card) is dusk glass: a starry frame around a frosted panel.
  useDuskGlass(elRef, card.ghost ? "card" : null, card.id);

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
      if (!pos?.pinned) drag.begin();
      dragState.current = { x: e.clientX, y: e.clientY, ox: pos?.x ?? 0, oy: pos?.y ?? 0, zoom: currentZoom(), moved: false, last: { x: pos?.x ?? 0, y: pos?.y ?? 0 } };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [pos, linking, ws, card.id, drag],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragState.current;
      if (!d) return;
      const dx = (e.clientX - d.x) / d.zoom;
      const dy = (e.clientY - d.y) / d.zoom;
      // A pinned card stays put (a click still opens it).
      if (pos?.pinned) return;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      if (d.moved) {
        d.last = { x: d.ox + dx, y: d.oy + dy };
        ws.moveCard(card.id, d.last);
        drag.over(e.clientX, e.clientY, card.id);
      }
    },
    [card.id, ws, drag, pos?.pinned],
  );
  // A cancelled press (window lost focus, gesture took over) keeps a move but never opens the card.
  const onPointerCancel = useCallback(() => {
    const d = dragState.current;
    dragState.current = null;
    if (d?.moved) {
      drag.over(-1, -1, card.id);
      ws.moveCard(card.id, d.last, { undoable: true, from: { x: d.ox, y: d.oy } });
      void ws.flushCanvas();
    }
  }, [ws, card.id, drag]);
  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    const d = dragState.current;
    dragState.current = null;
    if (!d) return;
    if (d.moved) {
      // Released over a folder (node, crumb or sidebar): it moves in, as one undo step.
      if (drag.drop(e.clientX, e.clientY, card.id)) return;
      ws.moveCard(card.id, d.last, { undoable: true, from: { x: d.ox, y: d.oy } });
      void ws.flushCanvas();
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    // A plain click on an image / clip tile opens the picture or the link (the menu's Open edits it).
    const att = !additive && !linking && (card.kind === "image" ? card.attachments.find(isImage) : card.kind === "clip" ? card.attachments.find(isClip) : undefined);
    if (att && elRef.current) onAttachment(card.id, att.id, elRef.current.getBoundingClientRect());
    else onOpen(card, additive);
  }, [ws, onOpen, onAttachment, linking, card, drag]);

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
  const kind = card.kind ?? "card";
  const staged = hasStage(card);
  const fixed = pos.h !== undefined;
  // Labels size to their text until resized; everything else starts at the default card width.
  const style: CSSProperties = { left: pos.x, top: pos.y, width: pos.w ?? (kind === "label" ? undefined : CARD_W), height: pos.h, zIndex: z };
  const menuBtn = (
    <button
      type="button"
      className="card-menu-btn"
      aria-label={`${KIND_LABEL[kind]} menu for ${card.title || "untitled"}`}
      onClick={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onMenu(card.id, r.left, r.bottom + 4);
      }}
    >
      ⋯
    </button>
  );
  // A sticky's colour is a swatch key; any other colour string (e.g. "#ffcc00" from Claude) is used as is.
  const customTint = kind === "sticky" && card.color && !swatchOf(card.color, null) ? card.color : null;
  const tint = kind === "sticky" && !customTint ? ` tint-${swatchOf(card.color)}` : "";
  if (customTint) (style as Record<string, unknown>)["--tint"] = customTint;
  const open = openQuestions(card.items);
  const doneCount = (card.items ?? []).filter((i) => i.done).length;
  const ghost = !!card.ghost;
  const head = staged ? (
    <div className="card-head">
      <span className={`dot dot-${card.stage}`} aria-hidden="true" />
      <span className="stage-name">{STAGE_LABEL[card.stage]}</span>
      {card.role === "tech" && <span className="tech-chip">{TECH_TITLE}</span>}
      {card.role === "decisions" && <span className="tech-chip">{DECISIONS_TITLE}</span>}
      {branchGroup(card) && <span className="fork-badge" title="Part of a fork — open the card to compare">⑂</span>}
      <button
        type="button"
        className="card-menu-btn card-prompt-btn"
        aria-label={`Build a prompt from ${card.title}`}
        title="Build a prompt from this card"
        onClick={(e) => {
          e.stopPropagation();
          onPrompt(card.id);
        }}
      >
        <IconSparkle />
      </button>
      {menuBtn}
    </div>
  ) : kind === "checklist" ? (
    <div className="card-head">
      <IconChecklist />
      <span className="stage-name">Checklist{card.items?.length ? ` · ${doneCount}/${card.items.length}` : ""}</span>
      {open > 0 && <span className="q-badge" title={`${open} unanswered question${open === 1 ? "" : "s"}`}>? {open}</span>}
      {menuBtn}
    </div>
  ) : kind === "label" && ghost ? null : (
    menuBtn
  );
  const media =
    kind === "image" ? (
      <ImageBody image={card.attachments.find(isImage)} slug={active} title={card.title} />
    ) : kind === "clip" ? (
      <ClipBody clip={card.attachments.find(isClip)} slug={active} title={card.title} />
    ) : null;
  const content = (
    <>
      {(kind !== "sticky" || card.title) && <h3>{card.title}</h3>}
      {kind !== "label" && card.attachments.length > 0 && <CardAttachments cardId={card.id} attachments={card.attachments} slug={active} onOpen={onAttachment} />}
      {kind === "checklist" && <ChecklistBody card={card} onItems={(items) => void ws.updateCard(card.id, { items })} />}
      {kind !== "label" && bodyHtml && <ScrollArea className="card-body md" dangerouslySetInnerHTML={{ __html: bodyHtml }} />}
    </>
  );
  const tagRow = kind !== "label" && card.tags.length > 0 && <div className="tags">{card.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>;
  const ghostActions = ghost && (
    <div className="ghost-actions">
      <button type="button" className="btn primary" title={card.merged_from?.length ? `Keep; the ${card.merged_from.length} original cards move to Trash` : undefined} onClick={(e) => { e.stopPropagation(); void ws.keepGhostCard(card.id); }}>Keep</button>
      <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); void ws.deleteCard(card.id); }}>Dismiss</button>
    </div>
  );
  return (
    <article
      ref={elRef}
      data-id={card.id}
      data-kind={kind}
      className={
        `card kind-${kind}` +
        (staged ? ` stage-${card.stage}` : "") +
        (card.role === "tech" ? " role-tech" : "") +
        (kind === "label" ? ` label-${labelSize(card)}` : "") +
        tint +
        (card.ghost ? " ghost" : "") +
        (isLinkSource ? " link-source" : "") +
        (linking ? " linkable" : "") +
        (selected ? " selected" : "") +
        (fixed ? " fixed-size" : "") +
        (pos.pinned ? " pinned" : "")
      }
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {ghost && kind !== "label" && (
        <div className="ghost-label"><span className="dusk-pill"><IconSparkle /> Claude suggests</span></div>
      )}
      {proposed && !ghost && (
        <DuskStrip seed={card.id} className="proposal-strip" onOpen={() => onProposal(card.id)}>
          <button type="button" className="dusk-pill" title="See what Claude suggests changing, then keep or dismiss it">
            <IconSparkle /> Claude suggests changes <span className="dusk-pill-cta">Review</span>
          </button>
        </DuskStrip>
      )}
      {!ghost ? (
        <>
          {head}
          {media ?? content}
          {tagRow}
        </>
      ) : kind === "label" ? (
        <>
          <span className="ghost-mark" title="Claude suggests" aria-label="Claude suggests"><IconSparkle /></span>
          <div className="ghost-panel">{content}</div>
          {menuBtn}
          {ghostActions}
        </>
      ) : media ? (
        <>
          {head}
          {media}
          <div className="ghost-panel ghost-strip">
            {kind === "image" && card.title && <h3>{card.title}</h3>}
            {tagRow}
            {ghostActions}
          </div>
        </>
      ) : (
        <div className="ghost-panel">
          {head}
          {content}
          {tagRow}
          {ghostActions}
        </div>
      )}
      {pos.pinned && (
        <button type="button" className="pin-badge" title="Position pinned. Click to unpin" aria-label="Unpin position" onClick={(e) => { e.stopPropagation(); drag.unpin(card.id); }}>
          <IconPin />
        </button>
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

/**
 * "N suggestions": every pending Claude suggestion in this project (ghost cards + edit proposals).
 * The popover lists them (click focuses the card) with Keep all / Dismiss all, each one undo step;
 * more than five asks first.
 */
function SuggestionsPill({ data, ws }: { data: ProjectData; ws: Workspace }) {
  const [pop, setPop] = useState<{ left: number; top: number } | null>(null);
  const [confirm, setConfirm] = useState<"keep" | "dismiss" | null>(null);
  const items = useMemo(() => {
    const props = data.proposals ?? {};
    return data.cards
      .filter((c) => c.ghost || props[c.id])
      .map((c) => ({ id: c.id, title: c.title || "Untitled", what: c.ghost ? (c.merged_from?.length ? "New card (merge)" : "New card") : "Changes" }));
  }, [data]);
  const n = items.length;
  if (!n) return null;
  const close = () => {
    setPop(null);
    setConfirm(null);
  };
  const settle = (what: "keep" | "dismiss") => {
    if (n > 5 && confirm !== what) return setConfirm(what);
    close();
    void (what === "keep" ? ws.keepAllSuggestions() : ws.dismissAllSuggestions());
  };
  return (
    <>
      <DuskStrip seed={data.slug} className="suggest-pill">
        <button
          type="button"
          className="dusk-pill"
          aria-expanded={!!pop}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPop({ left: r.left, top: r.bottom + 6 });
          }}
        >
          <IconSparkle /> {n} suggestion{n === 1 ? "" : "s"}
        </button>
      </DuskStrip>
      {pop && (
        <Layer onClose={close}>
          <div className="suggest-pop glass" style={{ left: pop.left, top: pop.top }} role="dialog" aria-label="Claude suggestions">
            <ScrollArea className="suggest-list">
              {items.map((it) => (
                <button key={it.id} type="button" className="theme-picker-row suggest-row" onClick={() => { close(); void ws.focusCard(it.id); }}>
                  <span className="suggest-title">{it.title}</span>
                  <span className="suggest-what">{it.what}</span>
                </button>
              ))}
            </ScrollArea>
            {confirm && <p className="suggest-confirm">{confirm === "keep" ? `Keep all ${n} suggestions?` : `Dismiss all ${n} suggestions?`} Undo brings them back.</p>}
            <div className="suggest-actions">
              <button type="button" className="btn" onClick={() => settle("dismiss")}>{confirm === "dismiss" ? "Yes, dismiss all" : "Dismiss all"}</button>
              <button type="button" className="btn primary" onClick={() => settle("keep")}>{confirm === "keep" ? "Yes, keep all" : "Keep all"}</button>
            </div>
          </div>
        </Layer>
      )}
    </>
  );
}

/** A one-line text prompt for menu actions (tag, link label, caption). Enter saves, Esc cancels. */
function AskText({ title, label, initial, placeholder, submit, onClose }: Parameters<MenuEnv["askText"]>[0] & { onClose: () => void }) {
  const [value, setValue] = useState(initial ?? "");
  return (
    <Modal onClose={onClose} label={title} size="sm" className="clip-prompt">
      <h3>{title}</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          submit(value);
        }}
      >
        <input className="name-input" autoFocus aria-label={label} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        <div className="editor-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function WebClipPrompt({ slug, onClose, onCreate }: { slug: string | null; onClose: () => void; onCreate: (clip: ClipAttachment, title: string) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const target = asUrl(url) ?? asUrl(`https://${url.trim()}`);
  const add = async () => {
    if (!target || !slug) return;
    setBusy(true);
    const clip = await api.fetchClip(slug, target).catch((): ClipAttachment => ({ id: "", type: "clip", url: target }));
    onCreate(clip, name.trim());
    onClose();
  };
  return (
    <Modal onClose={onClose} label="Web clip" size="sm" className="clip-prompt">
        <h3>Web clip</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="name-input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" disabled={busy} />
          <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Title (optional)" disabled={busy} />
          <div className="editor-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!target || busy}>
              {busy ? <><span className="spinner" aria-hidden="true" /> Fetching…</> : "Add"}
            </button>
          </div>
        </form>
    </Modal>
  );
}
