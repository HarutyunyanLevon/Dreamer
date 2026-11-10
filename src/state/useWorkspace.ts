import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Canvas, type CardPatch, type Link, type NewCard, type Pos, type ProjectData, type ProjectSummary } from "../api";

const INBOX = "inbox";
const CANVAS_SAVE_DEBOUNCE_MS = 400;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [contextCardId, setContextCardId] = useState<string | null>(null);
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
        if (seq === loadSeq.current && activeRef.current === slug) setData(d);
      } catch (e) {
        // The active project vanished (deleted on disk): fall back to the Inbox.
        if (list.some((p) => p.slug === INBOX) && slug !== INBOX) {
          activeRef.current = INBOX;
          setActive(INBOX);
          setData(await api.loadProject(INBOX));
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
        setData(await api.loadProject(start));
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

  const patchCanvas = useCallback((fn: (c: Canvas) => Canvas) => {
    setData((prev) => (prev ? { ...prev, canvas: fn(prev.canvas) } : prev));
  }, []);

  const flushCanvas = useCallback(() => {
    clearTimeout(canvasSaveTimer.current);
    const slug = activeRef.current;
    const d = dataRef.current;
    if (!slug || !d) return;
    api.saveCanvas(slug, d.canvas).catch((e) => setError(message(e)));
  }, []);

  const scheduleCanvasSave = useCallback(() => {
    clearTimeout(canvasSaveTimer.current);
    canvasSaveTimer.current = setTimeout(flushCanvas, CANVAS_SAVE_DEBOUNCE_MS);
  }, [flushCanvas]);

  useEffect(() => () => flushCanvas(), [flushCanvas]);

  const setViewport = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      patchCanvas((c) => ({ ...c, viewport: vp }));
      scheduleCanvasSave();
    },
    [patchCanvas, scheduleCanvasSave],
  );

  const moveCard = useCallback(
    (id: string, pos: Pos, opts?: { undoable?: boolean }) => {
      const prev = dataRef.current?.canvas.cards[id];
      patchCanvas((c) => ({ ...c, cards: { ...c.cards, [id]: pos } }));
      scheduleCanvasSave();
      if (opts?.undoable && prev) {
        pushUndo({
          label: "move card",
          undo: async () => {
            patchCanvas((c) => ({ ...c, cards: { ...c.cards, [id]: prev } }));
            flushCanvas();
          },
          redo: async () => {
            patchCanvas((c) => ({ ...c, cards: { ...c.cards, [id]: pos } }));
            flushCanvas();
          },
        });
      }
    },
    [patchCanvas, scheduleCanvasSave, flushCanvas, pushUndo],
  );

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
    createCard,
    updateCard,
    deleteCard,
    addLink,
    removeLink,
    setLinkLabel,
    addImage,
    moveCard,
    setViewport,
    flushCanvas,
    canUndo,
    canRedo,
    undo,
    redo,
    contextCardId,
    setContextCard: setContextCardId,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
