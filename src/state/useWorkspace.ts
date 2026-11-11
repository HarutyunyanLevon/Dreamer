import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Canvas, type CardPatch, type Link, type NewCard, type Pos, type ProjectData, type ProjectSummary } from "../api";

const INBOX = "inbox";
const CANVAS_SAVE_DEBOUNCE_MS = 400;

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
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [contextCardId, setContextCardId] = useState<string | null>(null);
  const [ghostLinks, setGhostLinks] = useState<GhostLink[]>([]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusSeq = useRef(0);
  const activeRef = useRef<string | null>(null);
  const dataRef = useRef<ProjectData | null>(null);
  const loadSeq = useRef(0);
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const canvasSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
        const d = await api.loadProject(slug);
        if (seq === loadSeq.current && activeRef.current === slug) {
          dataRef.current = d;
          setData(d);
        }
      } catch (e) {
        // The active project vanished (deleted on disk): fall back to the Inbox.
        if (list.some((p) => p.slug === INBOX) && slug !== INBOX) {
          activeRef.current = INBOX;
          setActive(INBOX);
          const d = await api.loadProject(INBOX);
          dataRef.current = d;
          setData(d);
        } else throw e;
      }
    } catch (e) {
      setError(message(e));
    }
  }, []);

  const select = useCallback(
    async (slug: string) => {
      activeRef.current = slug;
      setActive(slug);
      dataRef.current = null;
      setData(null);
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);
      api.updateSettings({ last_project: slug }).catch(() => {});
      await refresh();
    },
    [refresh],
  );

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, list] = await Promise.all([api.getSettings(), api.listProjects()]);
        if (cancelled) return;
        const start =
          list.find((p) => p.slug === settings.last_project)?.slug ??
          list.find((p) => !p.is_inbox)?.slug ??
          INBOX;
        activeRef.current = start;
        setActive(start);
        setProjects(list);
        const d = await api.loadProject(start);
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
      .onChange(() => {
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
    if (!slug || !d) return;
    await api.saveCanvas(slug, d.canvas).catch((e) => setError(message(e)));
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
    (id: string, rect: { x: number; y: number; w: number; h: number }, opts?: { undoable?: boolean; from?: Pos }) => {
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
  const sendToBack = useCallback((id: string) => setStacking(id, "back"), [setStacking]);

  // ----- cards -----

  const createCard = useCallback(
    async (card: NewCard) => {
      const slug = activeRef.current!;
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
      const prevPatch: CardPatch = {};
      if (before) {
        for (const k of Object.keys(patch) as (keyof CardPatch)[]) {
          (prevPatch as Record<string, unknown>)[k] = (before as Record<string, unknown>)[k];
        }
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

  const addImage = useCallback(
    async (id: string, file: File | Blob, nameHint: string) => {
      const slug = activeRef.current!;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const rel = await api.saveMedia(slug, nameHint, bytes);
      const card = dataRef.current?.cards.find((c) => c.id === id);
      await updateCard(id, { fields: { ...(card?.fields ?? {}), image: rel } });
    },
    [updateCard],
  );

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
    createProject: async (name: string) => {
      const p = await run(() => api.createProject(name));
      if (p) await select(p.slug);
    },
    notice,
    clearNotice: () => setNotice(null),
    /**
     * Sidebar "Delete project" (after the user confirmed). Moves the selection to the Inbox first,
     * so neither the reload nor the file watcher ever looks for the vanished folder.
     */
    deleteProject: async (slug: string) => {
      if (slug === INBOX) return;
      if (activeRef.current === slug) await select(INBOX);
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
    loseCard,
    refresh,
    addLink,
    removeLink,
    setLinkLabel,
    addImage,
    moveCard,
    resizeCard,
    bringToFront,
    sendToBack,
    setViewport,
    flushCanvas,
    canUndo,
    canRedo,
    undo,
    redo,
    contextCardId,
    setContextCard: setContextCardId,
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
