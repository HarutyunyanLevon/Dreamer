import { useCallback, useEffect, useRef, useState } from "react";
import { proposalPatch } from "../components/ProposalView";
import { api, type Attachment, type Canvas, type Card, type CardKind, type CardPatch, type EditProposal, type Frame, type HandoffScope, type Link, type NewCard, type OrganizeLayout, type OrganizePlanData, type Pos, type ProjectData, type ProjectSummary } from "../api";
import { CARD_H, CARD_W } from "../components/cardGeometry";
import { DECISIONS_TITLE, TECH_TEMPLATE, TECH_TITLE, parseItem } from "../components/kinds";
import type { NewArtifact } from "../api";
import { ARTIFACT_LABEL, artifactType, createPrompt } from "../components/artifacts/prompts";

const CANVAS_SAVE_DEBOUNCE_MS = 500;

/** Client-side attachment id, so a just-added item can be referenced before the core echoes it back. */
const newAttId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const newFrameId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Card positions + frames: what a frame edit changes (never the viewport). */
type Layout = Pick<Canvas, "cards" | "frames">;
const layoutOf = (c: Canvas): Layout => ({ cards: c.cards, frames: c.frames ?? {} });
const withFrames = (d: ProjectData): ProjectData => ({ ...d, canvas: { ...d.canvas, frames: d.canvas.frames ?? {} } });

const STAGE_ORDER = ["mist", "reverie", "lucid", "dream", "built"];

/** Target positions for an arrange op: groups side by side, each a grid (or one column). */
function layoutCards(list: string[], c: Canvas, byId: Map<string, Card>, layout: OrganizeLayout): Record<string, { x: number; y: number }> {
  const ps = list.map((id) => c.cards[id]);
  const ox = Math.min(...ps.map((p) => p.x));
  const oy = Math.min(...ps.map((p) => p.y));
  const cw = Math.max(...ps.map((p) => p.w ?? CARD_W)) + 40;
  const ch = Math.max(...ps.map((p) => p.h ?? CARD_H + 60)) + 40;
  // Reading order of where they sit now, so a re-layout keeps them roughly in place.
  const sorted = [...list].sort((a, b) => Math.round(c.cards[a].y / 100) - Math.round(c.cards[b].y / 100) || c.cards[a].x - c.cards[b].x);
  const square = (n: number) => Math.max(1, Math.ceil(Math.sqrt(n)));
  let groups: string[][];
  let colsOf: (n: number) => number = () => 1;
  if (layout === "grid") {
    groups = [sorted];
    colsOf = square;
  } else if (layout === "cluster-by-tag") {
    const freq = new Map<string, number>();
    for (const id of sorted) for (const t of byId.get(id)?.tags ?? []) freq.set(t, (freq.get(t) ?? 0) + 1);
    const tagOf = (id: string) => [...(byId.get(id)?.tags ?? [])].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b))[0] ?? "";
    const by = new Map<string, string[]>();
    for (const id of sorted) by.set(tagOf(id), [...(by.get(tagOf(id)) ?? []), id]);
    groups = [...by.entries()].sort((a, b) => (a[0] === "" ? 1 : 0) - (b[0] === "" ? 1 : 0) || b[1].length - a[1].length).map(([, g]) => g);
    colsOf = (n) => Math.min(3, square(n));
  } else if (layout === "stage-columns") {
    groups = STAGE_ORDER.map((st) => sorted.filter((id) => byId.get(id)?.stage === st)).filter((g) => g.length);
    const rest = sorted.filter((id) => !STAGE_ORDER.includes(byId.get(id)?.stage ?? ""));
    if (rest.length) groups.push(rest);
  } else {
    // flow-by-links: a card sits one column right of the furthest card linking to it.
    const inSet = new Set(sorted);
    const depth = new Map(sorted.map((id) => [id, 0]));
    for (let pass = 0; pass < sorted.length; pass++) {
      let changed = false;
      for (const a of sorted) {
        for (const l of byId.get(a)?.links ?? []) {
          const d = depth.get(a)! + 1;
          if (inSet.has(l.to) && d < sorted.length && d > depth.get(l.to)!) {
            depth.set(l.to, d);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const max = Math.max(0, ...depth.values());
    groups = Array.from({ length: max + 1 }, (_, d) => sorted.filter((id) => depth.get(id) === d)).filter((g) => g.length);
  }
  const out: Record<string, { x: number; y: number }> = {};
  let x = ox;
  for (const g of groups) {
    const cols = colsOf(g.length);
    g.forEach((id, i) => (out[id] = { x: Math.round(x + (i % cols) * cw), y: Math.round(oy + Math.floor(i / cols) * ch) }));
    x += Math.min(cols, g.length) * cw + 80;
  }
  return out;
}

/** What an organize plan does to the canvas (pure: the canvas preview and Apply share it). */
export interface OrganizeSim {
  canvas: Canvas;
  /** Ops that take effect (checked). */
  effective: boolean[];
  /** Re-laid-out card ids. */
  arranged: Set<string>;
  /** Cards whose tags change, with their new lists. */
  tags: { id: string; tags: string[] }[];
  /** tempId -> the id it got. */
  ids: Record<string, string>;
}

/** Runs the checked ops of `plan` on `c0`. */
export function simulateOrganize(c0: Canvas, cards: Card[], plan: OrganizePlanData, checked: boolean[], idFor: (tempId: string) => string): OrganizeSim {
  let c = c0;
  const ids: Record<string, string> = {};
  const byId = new Map(cards.map((x) => [x.id, x]));
  const effective = plan.ops.map(() => false);
  const arranged = new Set<string>();
  const tagMap = new Map<string, string[]>();
  plan.ops.forEach((op, i) => {
    if (checked[i] === false) return;
    if (op.op === "rename") {
      const id = ids[op.id] ?? op.id;
      if (!c.frames[id]) return;
      c = { ...c, frames: { ...c.frames, [id]: { ...c.frames[id], title: op.title } } };
    } else if (op.op === "create_frame") {
      const id = idFor(op.tempId);
      ids[op.tempId] = id;
      const z = Math.max(-1, ...Object.values(c.frames).map((f) => f.z)) + 1;
      c = { ...c, frames: { ...c.frames, [id]: { ...op.rect, title: op.title, z, ...(op.color ? { color: op.color } : {}) } } };
    } else if (op.op === "arrange") {
      const list = op.ids.filter((id) => c.cards[id] && !c.cards[id].pinned);
      if (!list.length) return;
      const pos = layoutCards(list, c, byId, op.layout);
      const next = { ...c.cards };
      for (const [id, p] of Object.entries(pos)) next[id] = { ...next[id], ...p };
      c = { ...c, cards: next };
      list.forEach((id) => arranged.add(id));
    } else if (op.op === "place") {
      // Explicit positions (the organize pipeline's own layout); pinned cards never move.
      const next = { ...c.cards };
      let n = 0;
      for (const [id, p] of Object.entries(op.positions)) {
        if (!c.cards[id] || c.cards[id].pinned) continue;
        next[id] = { ...next[id], x: p.x, y: p.y };
        arranged.add(id);
        n++;
      }
      if (!n) return;
      c = { ...c, cards: next };
    } else if (op.op === "retag") {
      const card = byId.get(op.id);
      if (!card) return;
      const cur = tagMap.get(op.id) ?? card.tags;
      tagMap.set(op.id, [...cur.filter((t) => !op.remove.includes(t)), ...op.add.filter((t) => !cur.includes(t))]);
    } else return;
    effective[i] = true;
  });
  const tags = [...tagMap].filter(([id, t]) => t.join("\n") !== (byId.get(id)?.tags ?? []).join("\n")).map(([id, t]) => ({ id, tags: t }));
  return { canvas: c, effective, arranged, tags, ids };
}

/** The plan card that's open in chat: the canvas previews it (hover = one op's items). */
export interface OrganizePreview {
  plan: OrganizePlanData;
  checked: boolean[];
  hover: number | null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A link Claude proposed (via /related). Lives only in memory until the user clicks Keep, which
 * writes a real link to the card file; Dismiss drops it. Never written to disk as a proposal.
 */
export interface GhostLink {
  key: string;
  slug: string;
  from: string;
  to: string;
  label?: string;
  reason?: string;
}

/** A request for the canvas to pan/zoom to a card (from a search chip or Ctrl+K). */
export interface FocusRequest {
  id: string;
  slug: string;
  n: number;
}

/** Text for the chat panel: `send` sends it as a turn, otherwise it fills and focuses the input. */
export interface ChatRequest {
  text: string;
  display?: string;
  send?: boolean;
  /** Thread to use: a card id, or null for the project thread. Absent = the current thread. */
  thread?: string | null;
  /** With `display`: show only a typing indicator while Claude answers (grill-me style turns). */
  quiet?: boolean;
  /** An artifact turn on Claude in that artifact's thread (create, chip, regenerate). */
  artifact?: string;
  /** The chat thread an artifact request came from: its recap goes along. */
  recapFrom?: string;
  /** Wait while Claude is busy (e.g. the chat turn that asked for it is still finishing). */
  wait?: boolean;
  n: number;
}

/** Opens the handoff pack dialog ("Summarize") with this scope preselected. */
export interface HandoffRequest {
  scope: HandoffScope;
  n: number;
}

interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/** Workspace state for the UI: project list, active project, its cards. Reloads when files change on disk. */
export function useWorkspace() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNoticeText] = useState<string | null>(null);
  /** The current notice offers an Undo button (e.g. after deleting cards). */
  const [noticeUndo, setNoticeUndo] = useState(false);
  const setNotice = useCallback((n: string | null) => {
    setNoticeText(n);
    setNoticeUndo(false);
  }, []);
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [contextCardId, setContextCardId] = useState<string | null>(null);
  /** Card ids selected on the canvas (kept in sync by CanvasArea; read by the chat per turn). */
  const canvasSelection = useRef<string[]>([]);
  const setCanvasSelection = useCallback((ids: string[]) => void (canvasSelection.current = ids), []);
  const getCanvasSelection = useCallback(() => canvasSelection.current, []);
  const [ghostLinks, setGhostLinks] = useState<GhostLink[]>([]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusSeq = useRef(0);
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null);
  const chatSeq = useRef(0);
  const [handoffRequest, setHandoffRequest] = useState<HandoffRequest | null>(null);
  const handoffSeq = useRef(0);
  /** The Memory modal is open for the active project. */
  const [memoryOpen, setMemoryOpen] = useState(false);
  const activeRef = useRef<string | null>(null);
  /** Linking mode (the Link tool or L). */
  const [linkMode, setLinkModeState] = useState(false);
  const [linkFrom, setLinkFromState] = useState<string | null>(null);
  const setLinking = useCallback((on: boolean, from: string | null = null) => {
    setLinkModeState(on);
    setLinkFromState(on ? from : null);
  }, []);
  const dataRef = useRef<ProjectData | null>(null);
  /** A merge ghost's originals that are still on the canvas. */
  /** The values `patch` overwrites on `before`, for undo. A list that was absent comes back as [] (absent would not clear it). */
  const prevOf = (before: Card, patch: CardPatch): CardPatch => {
    const prev: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      const v = (before as Record<string, unknown>)[k];
      prev[k] = v === undefined && Array.isArray((patch as Record<string, unknown>)[k]) ? [] : v;
    }
    return prev as CardPatch;
  };
  const liveOriginals = (c: Card) => (c.merged_from ?? []).filter((o) => dataRef.current?.cards.some((x) => x.id === o));
  const loadSeq = useRef(0);
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const canvasSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Watcher events before this time (performance.now) are echoes of our own canvas save. */
  const selfWriteUntil = useRef(0);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      const slug = activeRef.current;
      if (!slug) return;
      const seq = ++loadSeq.current;
      try {
        const d = withFrames(await api.loadProject(slug));
        if (seq === loadSeq.current && activeRef.current === slug) {
          // The persisted viewport applies only on first load; after that the live camera wins, so
          // a reload (our own save echoing through the watcher, or any edit) never moves the view.
          const live = dataRef.current;
          const next = live && live.slug === slug ? { ...d, canvas: { ...d.canvas, viewport: live.canvas.viewport } } : d;
          dataRef.current = next;
          setData(next);
        }
      } catch (e) {
        // The active project vanished (deleted on disk): fall back to the first one left.
        const other = list.find((p) => p.slug !== slug);
        if (!other) throw e;
        activeRef.current = other.slug;
        setActive(other.slug);
        const d = withFrames(await api.loadProject(other.slug));
        dataRef.current = d;
        setData(d);
      }
    } catch (e) {
      setError(message(e));
    }
  }, []);

  const select = useCallback(
    async (slug: string) => {
      activeRef.current = slug;
      setActive(slug);
      setLinking(false);
      dataRef.current = null;
      setData(null);
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);
      api.updateSettings({ last_project: slug }).catch(() => {});
      await refresh();
    },
    [refresh, setLinking],
  );

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, list] = await Promise.all([api.getSettings(), api.listProjects()]);
        if (cancelled) return;
        const start = list.find((p) => p.slug === settings.last_project)?.slug ?? list[0]?.slug;
        setProjects(list);
        if (!start) return;
        activeRef.current = start;
        setActive(start);
        const d = withFrames(await api.loadProject(start));
        dataRef.current = d;
        setData(d);
      } catch (e) {
        setError(message(e));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live updates from disk.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    let disposed = false;
    api
      .onChange((events) => {
        // Echo of our own canvas.json write: nothing to reload.
        // memory.md and its log have their own listeners (the Memory modal); the canvas ignores them.
        if (events.every((e) => e.scope === "memory" || e.scope === "artifact")) return;
        if (performance.now() < selfWriteUntil.current && events.every((e) => e.scope === "project" && e.project === activeRef.current)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 120);
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch((e) => setError(message(e)));
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsub?.();
    };
  }, [refresh]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        const r = await fn();
        await refresh();
        return r;
      } catch (e) {
        setError(message(e));
        return undefined;
      }
    },
    [refresh],
  );

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStack.current.push(entry);
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  /** Runs `fn` and folds every undo entry it pushed into one step. */
  const grouped = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      const start = undoStack.current.length;
      await fn();
      const added = undoStack.current.splice(start);
      if (added.length < 2) return void added.forEach(pushUndo);
      pushUndo({
        label,
        undo: async () => {
          for (const e of [...added].reverse()) await e.undo();
        },
        redo: async () => {
          for (const e of added) await e.redo();
        },
      });
    },
    [pushUndo],
  );

  const undo = useCallback(async () => {
    const entry = undoStack.current.pop();
    setCanUndo(undoStack.current.length > 0);
    if (!entry) return;
    try {
      await entry.undo();
      redoStack.current.push(entry);
      setCanRedo(true);
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  }, [refresh]);

  const redo = useCallback(async () => {
    const entry = redoStack.current.pop();
    setCanRedo(redoStack.current.length > 0);
    if (!entry) return;
    try {
      await entry.redo();
      undoStack.current.push(entry);
      setCanUndo(true);
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  }, [refresh]);

  // ----- canvas: pan/zoom + drag, persisted with a short debounce -----

  // dataRef is updated synchronously here (not only by the effect after render), so a
  // flushCanvas() right after a patch saves the patched canvas, not the previous one.
  const patchCanvas = useCallback((fn: (c: Canvas) => Canvas) => {
    const prev = dataRef.current;
    if (!prev) return;
    const next = { ...prev, canvas: fn(prev.canvas) };
    dataRef.current = next;
    setData(next);
  }, []);

  const flushCanvas = useCallback(async () => {
    clearTimeout(canvasSaveTimer.current);
    const slug = activeRef.current;
    const d = dataRef.current;
    if (!slug || !d || d.slug !== slug) return;
    selfWriteUntil.current = performance.now() + 800;
    await api.saveCanvas(slug, d.canvas).catch((e) => setError(message(e)));
    selfWriteUntil.current = performance.now() + 500;
  }, []);

  const scheduleCanvasSave = useCallback(() => {
    clearTimeout(canvasSaveTimer.current);
    canvasSaveTimer.current = setTimeout(flushCanvas, CANVAS_SAVE_DEBOUNCE_MS);
  }, [flushCanvas]);

  useEffect(() => () => void flushCanvas(), [flushCanvas]);

  const setViewport = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      patchCanvas((c) => ({ ...c, viewport: vp }));
      scheduleCanvasSave();
    },
    [patchCanvas, scheduleCanvasSave],
  );

  /** Merge into a card's canvas entry (keeps size and z-order when only x/y change). */
  const patchPos = useCallback(
    (id: string, patch: Partial<Pos>) => patchCanvas((c) => (c.cards[id] ? { ...c, cards: { ...c.cards, [id]: { ...c.cards[id], ...patch } } } : c)),
    [patchCanvas],
  );

  /** Pushes an undo entry that restores a card's whole canvas entry. */
  const pushPosUndo = useCallback(
    (label: string, id: string, before: Pos, after: Pos) => {
      pushUndo({
        label,
        undo: async () => {
          patchCanvas((c) => ({ ...c, cards: { ...c.cards, [id]: before } }));
          await flushCanvas();
        },
        redo: async () => {
          patchCanvas((c) => ({ ...c, cards: { ...c.cards, [id]: after } }));
          await flushCanvas();
        },
      });
    },
    [patchCanvas, flushCanvas, pushUndo],
  );

  const moveCard = useCallback(
    (id: string, pos: Pos, opts?: { undoable?: boolean; from?: Pos }) => {
      patchPos(id, { x: pos.x, y: pos.y });
      scheduleCanvasSave();
      // `from` must be the position at drag-start, passed by the caller: by the time a drag ends,
      // `dataRef` already holds the dragged-to position (every intermediate move went through here
      // too), so reading "the previous position" from state at this point would just be `pos` again.
      if (opts?.undoable && opts.from) {
        const from = opts.from;
        pushUndo({
          label: "move card",
          undo: async () => {
            patchPos(id, { x: from.x, y: from.y });
            await flushCanvas();
          },
          redo: async () => {
            patchPos(id, { x: pos.x, y: pos.y });
            await flushCanvas();
          },
        });
      }
    },
    [patchPos, scheduleCanvasSave, flushCanvas, pushUndo],
  );

  /**
   * Resize: `rect` may move x/y too (dragging a top/left handle). Live calls during a drag just
   * patch state; the final call passes `{ undoable, from }` (the Pos at drag start).
   */
  const resizeCard = useCallback(
    (id: string, rect: { x: number; y: number; w: number; h?: number }, opts?: { undoable?: boolean; from?: Pos }) => {
      patchPos(id, rect);
      if (opts?.undoable && opts.from) {
        const before = opts.from;
        const after = { ...before, ...rect };
        void flushCanvas();
        pushPosUndo("resize card", id, before, after);
      } else scheduleCanvasSave();
    },
    [patchPos, scheduleCanvasSave, flushCanvas, pushPosUndo],
  );

  /** Bring to front / send to back. No-op (and no undo entry) when nothing would change. */
  const setStacking = useCallback(
    (id: string, where: "front" | "back") => {
      const c = dataRef.current?.canvas;
      const before = c?.cards[id];
      if (!c || !before) return;
      const others = Object.entries(c.cards).filter(([k]) => k !== id).map(([, p]) => p.z ?? 0);
      const top = others.length ? Math.max(...others) : 0;
      const bottom = others.length ? Math.min(...others) : 0;
      const after: Pos =
        where === "front" ? { ...before, z: top + 1, back: undefined } : { ...before, z: bottom - 1, back: true };
      if (where === "front" && !before.back && (before.z ?? 0) > top) return;
      if (where === "back" && before.back && (before.z ?? 0) < bottom) return;
      patchCanvas((cv) => ({ ...cv, cards: { ...cv.cards, [id]: after } }));
      void flushCanvas();
      pushPosUndo(where === "front" ? "bring to front" : "send to back", id, before, after);
    },
    [patchCanvas, flushCanvas, pushPosUndo],
  );
  const bringToFront = useCallback((id: string) => setStacking(id, "front"), [setStacking]);
  // ----- frames: every committed change is one undo step restoring positions + frames -----

  const pushLayoutUndo = useCallback(
    (label: string, before: Layout, after: Layout) => {
      const apply = (l: Layout) => async () => {
        patchCanvas((c) => ({ ...c, ...l }));
        await flushCanvas();
      };
      pushUndo({ label, undo: apply(before), redo: apply(after) });
    },
    [patchCanvas, flushCanvas, pushUndo],
  );

  /** Snapshot for a gesture's undo entry (take it at gesture start). */
  const layoutSnapshot = useCallback((): Layout | null => (dataRef.current ? layoutOf(dataRef.current.canvas) : null), []);

  /** Live frame change during a drag (no undo, debounced save). `cardMoves` moves member cards with it. */
  const patchFrameLive = useCallback(
    (id: string, patch: Partial<Frame>, cardMoves?: Record<string, { x: number; y: number }>) => {
      patchCanvas((c) => {
        const f = c.frames?.[id];
        if (!f) return c;
        let cards = c.cards;
        if (cardMoves) {
          cards = { ...cards };
          for (const [cid, p] of Object.entries(cardMoves)) if (cards[cid]) cards[cid] = { ...cards[cid], x: p.x, y: p.y };
        }
        return { ...c, cards, frames: { ...c.frames, [id]: { ...f, ...patch } } };
      });
      scheduleCanvasSave();
    },
    [patchCanvas, scheduleCanvasSave],
  );

  /** End of a frame gesture: save now and push one undo entry back to `before`. */
  const commitLayout = useCallback(
    (label: string, before: Layout) => {
      const d = dataRef.current;
      if (!d) return;
      const after = layoutOf(d.canvas);
      if (after.cards === before.cards && after.frames === before.frames) return;
      void flushCanvas();
      pushLayoutUndo(label, before, after);
    },
    [flushCanvas, pushLayoutUndo],
  );

  /** Pin or unpin card positions (one undo step for all). */
  const setPinned = useCallback(
    (ids: string | string[], pinned: boolean) => {
      const list = Array.isArray(ids) ? ids : [ids];
      const before = layoutSnapshot();
      if (!before) return;
      patchCanvas((c) => {
        const cards = { ...c.cards };
        for (const id of list) if (cards[id]) cards[id] = { ...cards[id], pinned: pinned || undefined };
        return { ...c, cards };
      });
      commitLayout(pinned ? "pin position" : "unpin position", before);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchCanvas, commitLayout],
  );

  /** Bring several cards to front / send them to back, keeping their relative order (one undo step). */
  const stackCards = useCallback(
    (ids: string[], where: "front" | "back") => {
      const before = layoutSnapshot();
      if (!before) return;
      patchCanvas((c) => {
        const zs = (skip: string[]) => Object.entries(c.cards).filter(([k]) => !skip.includes(k)).map(([, p]) => p.z ?? 0);
        const others = zs(ids);
        const top = others.length ? Math.max(...others) : 0;
        const bottom = others.length ? Math.min(...others) : 0;
        const ordered = ids.filter((id) => c.cards[id]).sort((a, b) => (c.cards[a].z ?? 0) - (c.cards[b].z ?? 0));
        const cards = { ...c.cards };
        ordered.forEach((id, i) => {
          cards[id] = where === "front" ? { ...cards[id], z: top + 1 + i, back: undefined } : { ...cards[id], z: bottom - ordered.length + i, back: true };
        });
        return { ...c, cards };
      });
      commitLayout(where === "front" ? "bring to front" : "send to back", before);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchCanvas, commitLayout],
  );

  const [organizePreview, setOrganizePreview] = useState<OrganizePreview | null>(null);

  /** Applies the checked ops of a plan as ONE undo step (the canvas in one write, then tags). */
  const applyOrganize = useCallback(
    async (plan: OrganizePlanData, checked: boolean[]) => {
      const slug = activeRef.current;
      if (!slug || plan.slug !== slug) {
        setNotice("Open that project to apply its plan.");
        return false;
      }
      await flushCanvas();
      const d = dataRef.current;
      if (!d) return false;
      const sim = simulateOrganize(d.canvas, d.cards, plan, checked, newFrameId);
      if (!sim.effective.some(Boolean)) return false;
      const was = layoutOf(d.canvas);
      const now = layoutOf(sim.canvas);
      const before = sim.tags.map((e) => ({ id: e.id, tags: d.cards.find((c) => c.id === e.id)?.tags ?? [] }));
      const label = `Claude organized ${plan.scopeName}`;
      const setTags = async (list: { id: string; tags: string[] }[]) => {
        for (const e of list) await api.updateCard(slug, e.id, { tags: e.tags });
        if (list.length) await refresh();
      };
      const put = async (l: Layout, tags: { id: string; tags: string[] }[]) => {
        patchCanvas((c) => ({ ...c, ...l }));
        await flushCanvas();
        await setTags(tags);
      };
      try {
        await put(now, sim.tags);
      } catch (e) {
        setError(message(e));
        return false;
      }
      pushUndo({ label, undo: () => put(was, before), redo: () => put(now, sim.tags) });
      setNotice(`${label}.`);
      setNoticeUndo(true);
      return true;
    },
    [flushCanvas, patchCanvas, refresh, pushUndo, setNotice],
  );

  const createFrame = useCallback(
    (rect: { x: number; y: number; w: number; h: number }, title = "Untitled frame", color?: string): string | null => {
      const d = dataRef.current;
      if (!d) return null;
      const before = layoutOf(d.canvas);
      const id = newFrameId();
      const zs = Object.values(before.frames).map((f) => f.z);
      const frame: Frame = { ...rect, title, z: zs.length ? Math.max(...zs) + 1 : 0, ...(color ? { color } : {}) };
      patchCanvas((c) => ({ ...c, frames: { ...(c.frames ?? {}), [id]: frame } }));
      commitLayout("add frame", before);
      return id;
    },
    [patchCanvas, commitLayout],
  );

  /** Moves cards (align, distribute) as one undo step. */
  const arrangeCards = useCallback(
    (label: string, moves: Record<string, { x: number; y: number }>) => {
      const before = layoutSnapshot();
      if (!before) return;
      patchCanvas((c) => {
        const cards = { ...c.cards };
        for (const [id, p] of Object.entries(moves)) if (cards[id]) cards[id] = { ...cards[id], x: Math.round(p.x), y: Math.round(p.y) };
        return { ...c, cards };
      });
      commitLayout(label, before);
    },
    [layoutSnapshot, patchCanvas, commitLayout],
  );

  const updateFrame = useCallback(
    (id: string, patch: Partial<Frame>, label = "edit frame") => {
      const before = layoutSnapshot();
      if (!before?.frames[id]) return;
      patchCanvas((c) => ({ ...c, frames: { ...c.frames, [id]: { ...c.frames[id], ...patch } } }));
      commitLayout(label, before);
    },
    [layoutSnapshot, patchCanvas, commitLayout],
  );

  /** Deletes the frame only; its cards stay where they are. */
  const deleteFrame = useCallback(
    (id: string) => {
      const before = layoutSnapshot();
      if (!before?.frames[id]) return;
      patchCanvas((c) => {
        const frames = { ...c.frames };
        delete frames[id];
        return { ...c, frames };
      });
      commitLayout("delete frame", before);
      setNotice("Frame deleted; its cards stay.");
      setNoticeUndo(true);
    },
    [layoutSnapshot, patchCanvas, commitLayout, setNotice],
  );

  /** Deletes a frame and moves its cards to Trash, as one undo step. */
  const deleteFrameAndCards = useCallback(
    async (frameId: string, cardIds: string[]) => {
      const slug = activeRef.current;
      const before = layoutSnapshot();
      if (!slug || !before?.frames[frameId]) return;
      const dropFrame = async () => {
        patchCanvas((c) => {
          const frames = { ...c.frames };
          delete frames[frameId];
          return { ...c, frames };
        });
        await flushCanvas();
      };
      const redo = async () => {
        // Frame first: a canvas save after the cards are trashed would write their old positions back.
        await dropFrame();
        for (const id of cardIds) await api.deleteCard(slug, id);
      };
      const undo = async () => {
        for (const id of [...cardIds].reverse()) await api.restoreCard(slug, id);
        await refresh();
        patchCanvas((c) => ({ ...c, ...before }));
        await flushCanvas();
      };
      try {
        await redo();
      } catch (e) {
        setError(message(e));
      }
      pushUndo({ label: "delete frame and cards", undo, redo });
      setNotice(cardIds.length ? `Frame and ${cardIds.length} card${cardIds.length === 1 ? "" : "s"} moved to Trash.` : "Frame deleted.");
      setNoticeUndo(true);
      await refresh();
    },
    [layoutSnapshot, patchCanvas, flushCanvas, pushUndo, refresh, setNotice],
  );

  const sendToBack = useCallback((id: string) => setStacking(id, "back"), [setStacking]);

  // ----- cards -----

  const createCard = useCallback(
    async (card: NewCard) => {
      const slug = activeRef.current!;
      // New cards land on the open canvas.
      const created = await run(() => api.createCard(slug, card));
      if (created) {
        pushUndo({
          label: "create card",
          undo: async () => api.deleteCard(slug, created.id).then(() => {}),
          redo: async () => api.restoreCard(slug, created.id).then(() => {}),
        });
      }
      return created;
    },
    [run, pushUndo],
  );

  const updateCard = useCallback(
    async (id: string, patch: CardPatch) => {
      const slug = activeRef.current!;
      const before = dataRef.current?.cards.find((c) => c.id === id);
      const prevPatch: CardPatch = before ? prevOf(before, patch) : {};
      // Editing a Claude suggestion keeps it: Keep (ghost off, a merge's originals to Trash) then
      // the edit, as one undo step. Moves and resizes never come through here.
      if (before?.ghost && !("ghost" in patch)) {
        const originals = liveOriginals(before);
        const reason = `merged into ${patch.title ?? before.title}`;
        const apply = async () => {
          const u = await api.updateCard(slug, id, { ghost: false });
          for (const o of originals) await api.loseCard(slug, o, reason);
          return Object.keys(patch).length ? api.updateCard(slug, id, patch) : u;
        };
        const revert = async () => {
          for (const o of originals) await api.restoreCard(slug, o);
          await api.updateCard(slug, id, { ...prevPatch, ghost: true });
        };
        const updated = await run(apply);
        if (updated) pushUndo({ label: "keep suggestion", undo: revert, redo: async () => void (await apply()) });
        return updated;
      }
      const updated = await run(() => api.updateCard(slug, id, patch));
      if (updated && before) {
        pushUndo({
          label: "update card",
          undo: async () => api.updateCard(slug, id, prevPatch).then(() => {}),
          redo: async () => api.updateCard(slug, id, patch).then(() => {}),
        });
      }
      return updated;
    },
    [run, pushUndo],
  );

  /** Patches several cards as one undo step (stage, tags, link reversal). */
  const updateMany = useCallback(
    async (label: string, edits: { id: string; patch: CardPatch }[]) => {
      const slug = activeRef.current;
      const cards = dataRef.current?.cards ?? [];
      if (!slug || !edits.length) return;
      const undoEdits = edits.flatMap(({ id, patch }) => {
        const before = cards.find((c) => c.id === id);
        return before ? [{ id, patch: prevOf(before, patch) }] : [];
      });
      // Editing a suggestion keeps it (same undo step); a merge's originals go to Trash with it.
      const ghosts = edits.flatMap(({ id }) => {
        const c = cards.find((x) => x.id === id);
        return c?.ghost ? [{ id: c.id, title: c.title, originals: liveOriginals(c) }] : [];
      });
      const apply = (list: { id: string; patch: CardPatch }[], keep: boolean) => async () => {
        if (keep) {
          for (const g of ghosts) {
            await api.updateCard(slug, g.id, { ghost: false });
            for (const o of g.originals) await api.loseCard(slug, o, `merged into ${g.title}`);
          }
        }
        for (const { id, patch } of list) await api.updateCard(slug, id, patch);
        if (!keep) {
          for (const g of ghosts) {
            for (const o of g.originals) await api.restoreCard(slug, o);
            await api.updateCard(slug, g.id, { ghost: true });
          }
        }
      };
      const ok = await run(async () => {
        await apply(edits, true)();
        return true;
      });
      if (ok) pushUndo({ label, undo: apply([...undoEdits].reverse(), false), redo: apply(edits, true) });
    },
    [run, pushUndo],
  );

  /**
   * Appends `text` to the project's Tech & constraints / Project decisions card, creating it when
   * missing, together with `edits` to other cards: one undo step.
   */
  const appendToRoleCard = useCallback(
    async (role: "tech" | "decisions", text: string, label: string, edits: { id: string; patch: CardPatch }[] = []) => {
      const slug = activeRef.current;
      if (!slug) return;
      const join = (body: string) => `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${text}`;
      const card = dataRef.current?.cards.find((c) => c.role === role && !c.ghost);
      if (card) return updateMany(label, [{ id: card.id, patch: { body: join(card.body) } }, ...edits]);
      const fresh: NewCard =
        role === "tech"
          ? { title: TECH_TITLE, role: "tech", body: TECH_TEMPLATE }
          : { title: DECISIONS_TITLE, role: "decisions", stage: "lucid", body: "Answers that settle open project questions." };
      const created = await run(() => api.createCard(slug, { ...fresh, body: join(fresh.body ?? "") }));
      if (!created) return;
      const cards = dataRef.current?.cards ?? [];
      const undoEdits = edits.flatMap(({ id, patch }) => {
        const before = cards.find((c) => c.id === id);
        return before ? [{ id, patch: prevOf(before, patch) }] : [];
      });
      const apply = async (list: { id: string; patch: CardPatch }[]) => {
        for (const { id, patch } of list) await api.updateCard(slug, id, patch);
      };
      await run(async () => (await apply(edits), true));
      pushUndo({
        label,
        undo: async () => {
          await apply([...undoEdits].reverse());
          await api.deleteCard(slug, created.id);
        },
        redo: async () => {
          await api.restoreCard(slug, created.id);
          await apply(edits);
        },
      });
    },
    [run, pushUndo, updateMany],
  );

  /**
   * Deletes checklist items. Answered questions go to Project decisions first (same undo step).
   */
  const deleteChecklistItems = useCallback(
    async (cardId: string, ids: string[]) => {
      const card = dataRef.current?.cards.find((c) => c.id === cardId);
      if (!card) return;
      const drop = new Set(ids);
      const gone = (card.items ?? []).filter((i) => drop.has(i.id));
      if (!gone.length) return;
      const patch: CardPatch = { items: (card.items ?? []).filter((i) => !drop.has(i.id)) };
      const answered = gone.filter((i) => i.question && i.answer?.trim());
      if (!answered.length) return void (await updateCard(cardId, patch));
      const text = answered.map((i) => `**Q:** ${parseItem(i.text).body}\n**A:** ${i.answer!.trim()}`).join("\n\n");
      await appendToRoleCard("decisions", text, answered.length > 1 ? "clear answered" : "delete item", [{ id: cardId, patch }]);
    },
    [updateCard, appendToRoleCard],
  );

  /** "Convert to": only the kind changes, so title, body, attachments (and items) carry over. */
  const convertKind = useCallback(
    async (id: string, kind: CardKind) => {
      const card = dataRef.current?.cards.find((c) => c.id === id);
      if (card && card.kind !== kind) await updateCard(id, { kind });
    },
    [updateCard],
  );

  const deleteCard = useCallback(
    async (id: string) => {
      const slug = activeRef.current!;
      const item = await run(() => api.deleteCard(slug, id));
      if (item) {
        pushUndo({
          label: "delete card",
          undo: async () => api.restoreCard(slug, id).then(() => {}),
          redo: async () => api.deleteCard(slug, id).then(() => {}),
        });
      }
      return item;
    },
    [run, pushUndo],
  );

  /** Move several cards to Trash ("deleted") as one undo step, with an Undo toast. No confirm. */
  const deleteCards = useCallback(
    async (ids: string[]) => {
      const slug = activeRef.current;
      if (!slug || ids.length === 0) return;
      const done: string[] = [];
      try {
        for (const id of ids) {
          await api.deleteCard(slug, id);
          done.push(id);
        }
      } catch (e) {
        setError(message(e));
      }
      if (done.length) {
        pushUndo({
          label: done.length === 1 ? "delete card" : `delete ${done.length} cards`,
          undo: async () => { for (const id of done) await api.restoreCard(slug, id); },
          redo: async () => { for (const id of done) await api.deleteCard(slug, id); },
        });
        setNotice(done.length === 1 ? "Card moved to Trash." : `${done.length} cards moved to Trash.`);
        setNoticeUndo(true);
      }
      await refresh();
    },
    [pushUndo, refresh],
  );

  const loseCard = useCallback(
    async (id: string, reason: string) => {
      const slug = activeRef.current!;
      const item = await run(() => api.loseCard(slug, id, reason));
      if (item) {
        pushUndo({
          label: "lose fork",
          undo: async () => api.restoreCard(slug, id).then(() => {}),
          redo: async () => api.loseCard(slug, id, reason).then(() => {}),
        });
      }
      return item;
    },
    [run, pushUndo],
  );

  const addLink = useCallback(
    (fromId: string, toId: string, label?: string) => {
      const from = dataRef.current?.cards.find((c) => c.id === fromId);
      if (!from || fromId === toId || from.links.some((l) => l.to === toId)) return;
      const links: Link[] = [...from.links, { to: toId, label }];
      void updateCard(fromId, { links });
    },
    [updateCard],
  );

  const removeLink = useCallback(
    (fromId: string, toId: string) => {
      const from = dataRef.current?.cards.find((c) => c.id === fromId);
      if (!from) return;
      void updateCard(fromId, { links: from.links.filter((l) => l.to !== toId) });
    },
    [updateCard],
  );

  const setLinkLabel = useCallback(
    (fromId: string, toId: string, label: string) => {
      const from = dataRef.current?.cards.find((c) => c.id === fromId);
      if (!from) return;
      void updateCard(fromId, { links: from.links.map((l) => (l.to === toId ? { ...l, label: label || undefined } : l)) });
    },
    [updateCard],
  );

  // ----- attachments: every change is one updateCard of the whole list, so Undo/Redo restore it -----

  const attachmentsOf = (id: string): Attachment[] => dataRef.current?.cards.find((c) => c.id === id)?.attachments ?? [];

  /** Replace a card's attachment list (reorder, remove, caption, cover) as one undo step. */
  const setAttachments = useCallback((id: string, list: Attachment[]) => updateCard(id, { attachments: list }), [updateCard]);

  /** Saves files under media/ and returns them as image attachments (not yet on any card). */
  const saveImages = useCallback(async (files: (File | Blob)[]): Promise<Attachment[]> => {
    const slug = activeRef.current!;
    const uploads = await Promise.all(
      files.map(async (f, i) => ({ name_hint: (f as File).name || `pasted-${i}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const rels = await api.saveMedia(slug, uploads);
    return rels.map((path) => ({ id: newAttId(), type: "image", path }));
  }, []);

  /** Save the files under media/ and append them as images (one undo step). */
  const addImages = useCallback(
    async (id: string, files: (File | Blob)[]) => {
      const slug = activeRef.current!;
      if (!files.length) return;
      try {
        const added = await saveImages(files);
        if (activeRef.current !== slug) return;
        await setAttachments(id, [...attachmentsOf(id), ...added]);
      } catch (e) {
        setError(message(e));
      }
    },
    [setAttachments, saveImages],
  );
  const addImage = useCallback((id: string, file: File | Blob, _nameHint?: string) => addImages(id, [file]), [addImages]);

  /** Fetch a page and append it as a clip. A failed fetch still adds a bare clip (with fetch_error). */
  const addClip = useCallback(
    async (id: string, url: string) => {
      const slug = activeRef.current!;
      try {
        const clip = await api.fetchClip(slug, url);
        if (activeRef.current !== slug) return null;
        await setAttachments(id, [...attachmentsOf(id), clip]);
        return clip;
      } catch (e) {
        setError(message(e));
        return null;
      }
    },
    [setAttachments],
  );

  /** Re-fetches a clip's page; Undo restores the previous preview. */
  const refreshClip = useCallback(
    async (id: string, attId: string) => {
      const slug = activeRef.current!;
      const before = attachmentsOf(id);
      const card = await run(() => api.refreshClip(slug, id, attId));
      if (card) {
        const after = card.attachments;
        pushUndo({
          label: "refresh preview",
          undo: async () => api.updateCard(slug, id, { attachments: before }).then(() => {}),
          redo: async () => api.updateCard(slug, id, { attachments: after }).then(() => {}),
        });
      }
      return card;
    },
    [run, pushUndo],
  );

  /**
   * Keep on a ghost card. A merge ghost (`merged_from`) also moves its originals to Trash, all as
   * one undo step. Dismiss needs nothing special: the originals were never touched.
   */
  const requestChat = useCallback((r: Omit<ChatRequest, "n">) => setChatRequest({ ...r, n: ++chatSeq.current }), []);

  /** "Answer with Claude": a quiet /grill-me checklist turn in the card's thread over its open questions. */
  const startChecklistGrill = useCallback(
    (cardId: string) => {
      const card = dataRef.current?.cards.find((c) => c.id === cardId);
      const open = (card?.items ?? []).filter((i) => i.question && !i.answer?.trim());
      if (!card || !open.length) return;
      const lines = open.map((i) => {
        const p = parseItem(i.text);
        return `[${i.id}] ${p.body}${p.context ? ` — ${p.context}` : ""}`;
      });
      setContextCardId(cardId);
      requestChat({ thread: cardId, send: true, quiet: true, text: `/grill-me checklist\n${lines.join("\n")}`, display: `/grill-me checklist (${open.length} open)` });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestChat],
  );

  // ----- artifacts -----

  /** Runs an artifact turn on Claude in the artifact's own thread (its chat opens there). */
  const runArtifact = useCallback(
    (id: string, text: string, display: string, o?: { recapFrom?: string }) => {
      setContextCardId(id);
      requestChat({ text, display, thread: id, send: true, artifact: id, wait: true, recapFrom: o?.recapFrom });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestChat],
  );

  /**
   * Creates an artifact card (undoable like any card) and, unless `generate` is false (a ghost),
   * starts its first Claude turn.
   */
  const createArtifact = useCallback(
    async (a: NewArtifact, o?: { generate?: boolean; recapFrom?: string }) => {
      const slug = activeRef.current!;
      const created = await run(() => api.artifactCreate(slug, a));
      if (!created) return null;
      pushUndo({
        label: "create artifact",
        undo: async () => api.deleteCard(slug, created.id).then(() => {}),
        redo: async () => api.restoreCard(slug, created.id).then(() => {}),
      });
      await refresh();
      if (o?.generate !== false && !a.ghost) runArtifact(created.id, createPrompt(a.type, created.title), `Make the ${ARTIFACT_LABEL[a.type].toLowerCase()}`, { recapFrom: o?.recapFrom });
      return created;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, pushUndo, runArtifact],
  );

  const keepGhostCard = useCallback(
    async (id: string) => {
      const slug = activeRef.current!;
      const card = dataRef.current?.cards.find((c) => c.id === id);
      const originals = (card?.merged_from ?? []).filter((o) => dataRef.current?.cards.some((c) => c.id === o));
      if (!card || originals.length === 0) {
        await updateCard(id, { ghost: false });
        // A ghost artifact (Claude's proposal) is generated once the user keeps it.
        if (card?.kind === "artifact") runArtifact(id, createPrompt(artifactType(card), card.title), `Make the ${ARTIFACT_LABEL[artifactType(card)].toLowerCase()}`);
        return;
      }
      const reason = `merged into ${card.title}`;
      const apply = async () => {
        await api.updateCard(slug, id, { ghost: false });
        for (const o of originals) await api.loseCard(slug, o, reason);
      };
      const revert = async () => {
        for (const o of originals) await api.restoreCard(slug, o);
        await api.updateCard(slug, id, { ghost: true });
      };
      const ok = await run(async () => {
        await apply();
        return true;
      });
      if (ok) pushUndo({ label: "keep merge", undo: revert, redo: apply });
    },
    [run, pushUndo, updateCard, runArtifact],
  );

  /**
   * Keep all / Dismiss all for the project's Claude suggestions (ghost cards + edit proposals),
   * each as one undo step. Keep applies every proposal; Dismiss trashes the ghosts and drops the
   * proposal files (Undo writes them back).
   */
  const settleSuggestions = useCallback(
    async (keep: boolean) => {
      const slug = activeRef.current;
      const d = dataRef.current;
      if (!slug || !d) return;
      const ghosts = d.cards.filter((c) => c.ghost).map((c) => ({ id: c.id, title: c.title, originals: liveOriginals(c) }));
      const props = Object.entries(d.proposals ?? {}).flatMap(([id, p]) => {
        const c = d.cards.find((x) => x.id === id);
        if (!c) return [];
        const patch = keep ? proposalPatch(c, p) : {};
        const prev: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) prev[k] = (c as unknown as Record<string, unknown>)[k];
        return [{ id, p: p as EditProposal, patch, prev: prev as CardPatch, ghost: !!c.ghost }];
      });
      if (!ghosts.length && !props.length) return;
      const apply = async () => {
        for (const g of ghosts) {
          if (keep) {
            await api.updateCard(slug, g.id, { ghost: false });
            for (const o of g.originals) await api.loseCard(slug, o, `merged into ${g.title}`);
          } else await api.deleteCard(slug, g.id);
        }
        for (const x of props) {
          if (keep && Object.keys(x.patch).length) await api.updateCard(slug, x.id, x.patch);
          await api.dismissProposal(slug, x.id);
        }
      };
      const revert = async () => {
        for (const x of [...props].reverse()) {
          if (keep && Object.keys(x.prev).length) await api.updateCard(slug, x.id, x.prev);
          await api.restoreProposal(slug, x.id, x.p);
        }
        for (const g of [...ghosts].reverse()) {
          if (keep) {
            for (const o of g.originals) await api.restoreCard(slug, o);
            await api.updateCard(slug, g.id, { ghost: true });
          } else await api.restoreCard(slug, g.id);
        }
      };
      const ok = await run(async () => {
        await apply();
        return true;
      });
      if (ok) pushUndo({ label: keep ? "keep all suggestions" : "dismiss all suggestions", undo: revert, redo: apply });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, pushUndo],
  );
  const keepAllSuggestions = useCallback(() => settleSuggestions(true), [settleSuggestions]);
  const dismissAllSuggestions = useCallback(() => settleSuggestions(false), [settleSuggestions]);

  // (requestChat is defined with the artifact actions, above keepGhostCard)

  // ----- ghost links (Claude's /related proposals) -----

  const addGhostLink = useCallback((g: Omit<GhostLink, "key">) => {
    const key = `${g.slug}:${g.from}->${g.to}`;
    setGhostLinks((prev) => (prev.some((x) => x.key === key) ? prev : [...prev, { ...g, key }]));
  }, []);

  const dropGhostLink = useCallback((key: string) => setGhostLinks((prev) => prev.filter((x) => x.key !== key)), []);

  const keepGhostLink = useCallback(
    async (g: GhostLink) => {
      const from = dataRef.current?.cards.find((c) => c.id === g.from);
      if (!from) return;
      dropGhostLink(g.key);
      if (from.links.some((l) => l.to === g.to)) return;
      const before = from.links;
      const after: Link[] = [...before, { to: g.to, label: g.label }];
      const ok = await run(() => api.updateCard(g.slug, g.from, { links: after }));
      if (!ok) {
        addGhostLink(g);
        return;
      }
      pushUndo({
        label: "keep link",
        undo: async () => {
          await api.updateCard(g.slug, g.from, { links: before });
          addGhostLink(g);
        },
        redo: async () => {
          await api.updateCard(g.slug, g.from, { links: after });
          dropGhostLink(g.key);
        },
      });
    },
    [run, pushUndo, addGhostLink, dropGhostLink],
  );

  const dismissGhostLink = useCallback(
    (g: GhostLink) => {
      dropGhostLink(g.key);
      pushUndo({
        label: "dismiss link",
        undo: async () => addGhostLink(g),
        redo: async () => dropGhostLink(g.key),
      });
    },
    [pushUndo, addGhostLink, dropGhostLink],
  );

  // ----- focus a card (search results) -----

  const focusCard = useCallback(
    async (id: string, slug?: string) => {
      const target = slug ?? activeRef.current;
      if (!target) return;
      if (target !== activeRef.current) await select(target);
      setContextCardId(id);
      setFocusRequest({ id, slug: target, n: ++focusSeq.current });
    },
    [select],
  );

  return {
    ready,
    projects,
    active,
    data,
    error,
    clearError: () => setError(null),
    select,
    /** Creates and selects a project. Returns the error text instead of toasting it, so the name
     *  field can show it inline and keep what the user typed. */
    createProject: async (name: string): Promise<string | null> => {
      try {
        const p = await api.createProject(name);
        await select(p.slug);
        return null;
      } catch (e) {
        await refresh();
        return message(e);
      }
    },
    notice,
    noticeUndo,
    clearNotice: () => setNotice(null),
    toast: setNotice,
    keepGhostCard,
    keepAllSuggestions,
    dismissAllSuggestions,
    chatRequest,
    requestChat,
    startChecklistGrill,
    createArtifact,
    runArtifact,
    clearChatRequest: () => setChatRequest(null),
    handoffRequest,
    openHandoff: (scope: HandoffScope) => setHandoffRequest({ scope, n: ++handoffSeq.current }),
    clearHandoff: () => setHandoffRequest(null),
    memoryOpen,
    setMemoryOpen,
    /**
     * Sidebar "Delete project" (after the user confirmed). Moves the selection to another project
     * first, so neither the reload nor the file watcher ever looks for the vanished folder.
     */
    deleteProject: async (slug: string) => {
      const other = projects.find((p) => p.slug !== slug);
      if (!other) return setNotice("This is the only project; a workspace keeps at least one.");
      if (activeRef.current === slug) await select(other.slug);
      try {
        const out = await api.deleteProject(slug);
        setNotice(out.recycled ? "Project moved to the Recycle Bin." : "Project deleted from disk.");
      } catch (e) {
        setError(message(e));
      }
      await refresh();
    },
    setProjectTheme: (themeId: string | null) => run(() => api.updateProject(activeRef.current!, { theme: themeId ?? "" })),
    createCard,
    updateCard,
    deleteCard,
    deleteCards,
    loseCard,
    refresh,
    addLink,
    removeLink,
    setLinkLabel,
    addImage,
    addImages,
    addClip,
    refreshClip,
    setAttachments,
    moveCard,
    resizeCard,
    bringToFront,
    sendToBack,
    layoutSnapshot,
    patchFrameLive,
    commitLayout,
    createFrame,
    updateFrame,
    deleteFrame,
    deleteFrameAndCards,
    arrangeCards,
    updateMany,
    appendToRoleCard,
    deleteChecklistItems,
    saveImages,
    convertKind,
    setViewport,
    flushCanvas,
    organizePreview,
    setOrganizePreview,
    applyOrganize,
    setPinned,
    stackCards,
    grouped,
    linkMode,
    linkFrom,
    setLinking,
    canUndo,
    canRedo,
    undo,
    redo,
    contextCardId,
    setContextCard: setContextCardId,
    setCanvasSelection,
    getCanvasSelection,
    ghostLinks: ghostLinks.filter((g) => g.slug === active),
    addGhostLink,
    keepGhostLink,
    dismissGhostLink,
    focusRequest,
    focusCard,
    clearFocus: () => setFocusRequest(null),
    setError,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
