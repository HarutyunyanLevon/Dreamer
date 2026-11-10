import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CardPatch, type NewCard, type ProjectData, type ProjectSummary } from "../api";

const INBOX = "inbox";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Workspace state for the UI: project list, active project, its cards. Reloads when files change on disk. */
export function useWorkspace() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const activeRef = useRef<string | null>(null);
  const loadSeq = useRef(0);

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
    createCard: (card: NewCard) => run(() => api.createCard(activeRef.current!, card)),
    updateCard: (id: string, patch: CardPatch) => run(() => api.updateCard(activeRef.current!, id, patch)),
    deleteCard: (id: string) => run(() => api.deleteCard(activeRef.current!, id)),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
