import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { claudeApi, type ClaudeEvent, type ClaudeStatus, type SearchResultRef } from "../api/claudeIndex";

let seq = 0;
const nextId = () => `c${Date.now()}-${++seq}`;
const SAVE_DEBOUNCE_MS = 400;

export interface ChatMessage {
  id: string;
  role: "user" | "claude";
  text: string;
  streaming?: boolean;
  isError?: boolean;
  question?: { question: string; choices: string[]; answered?: string };
  /** search_cards calls Claude made while writing this reply (shown as result chips). */
  searches?: { query: string; results: SearchResultRef[] }[];
}

type LinkProposal = Extract<ClaudeEvent, { type: "link_proposal" }>;

/** One chat thread: the selected card's, or the project's when no card is selected. */
interface Thread {
  slug: string;
  thread: string;
  messages: ChatMessage[];
  sessionId?: string;
  loaded: boolean;
}

const keyOf = (slug: string, thread: string) => `${slug}/${thread}`;

/**
 * Chat state, one thread per card (keyed by card id) plus a project-level thread. Threads are
 * loaded from and saved to `<project>/chats/<thread>.json`; each keeps its Claude session id so
 * the sidecar can resume it. Events are routed to their thread by message id, so a reply keeps
 * landing in the right thread even if the user selects another card meanwhile.
 */
export function useClaudeChat(opts: { slug: string | null; thread: string; onLinkProposal?: (p: LinkProposal) => void }) {
  const { slug, thread } = opts;
  const onLinkProposal = useRef(opts.onLinkProposal);
  onLinkProposal.current = opts.onLinkProposal;
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const busyId = useRef<string | null>(null);
  const threads = useRef(new Map<string, Thread>());
  const idToKey = useRef(new Map<string, string>());
  const currentKey = useRef<string | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const refreshStatus = useCallback(async () => {
    try {
      const s = await claudeApi.status();
      setStatus(s);
      return s;
    } catch (e) {
      const s = { installed: false, error: String(e) };
      setStatus(s);
      return s;
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const save = useCallback((key: string) => {
    clearTimeout(saveTimers.current.get(key));
    saveTimers.current.set(
      key,
      setTimeout(() => {
        const t = threads.current.get(key);
        if (!t || !t.loaded) return;
        const messages = t.messages.map((m) => ({ ...m, streaming: undefined }));
        api.saveChat(t.slug, t.thread, { version: 1, sessionId: t.sessionId, messages }).catch(() => {});
      }, SAVE_DEBOUNCE_MS),
    );
  }, []);

  /** Apply `fn` to one thread's messages (wherever it is) and re-render if it's on screen. */
  const update = useCallback(
    (key: string | undefined, fn: (m: ChatMessage[]) => ChatMessage[], persist = false) => {
      if (!key) return;
      const t = threads.current.get(key);
      if (!t) return;
      t.messages = fn(t.messages);
      if (key === currentKey.current) setMessages(t.messages);
      if (persist) save(key);
    },
    [save],
  );

  // Switch threads when the project or selected card changes; load from disk the first time.
  useEffect(() => {
    if (!slug) {
      currentKey.current = null;
      setMessages([]);
      return;
    }
    const key = keyOf(slug, thread);
    currentKey.current = key;
    const cached = threads.current.get(key);
    if (cached) {
      setMessages(cached.messages);
      return;
    }
    const t: Thread = { slug, thread, messages: [], loaded: false };
    threads.current.set(key, t);
    setMessages([]);
    api
      .loadChat(slug, thread)
      .then((file) => {
        t.messages = [...(Array.isArray(file.messages) ? (file.messages as ChatMessage[]) : []), ...t.messages];
        t.sessionId = file.sessionId ?? t.sessionId;
      })
      .catch(() => {})
      .finally(() => {
        t.loaded = true;
        if (currentKey.current === key) setMessages(t.messages);
      });
  }, [slug, thread]);

  const finishBusy = (id: string | null) => {
    if (id && busyId.current === id) {
      busyId.current = null;
      setBusy(false);
    }
  };

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    claudeApi
      .onEvent((e) => {
        if (e.type === "delta") {
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, text: m.text + e.text } : m)));
        } else if (e.type === "message_done") {
          const key = idToKey.current.get(e.id);
          const t = key ? threads.current.get(key) : undefined;
          if (t && e.sessionId) t.sessionId = e.sessionId;
          update(key, (ms) => ms.map((m) => (m.id === e.id ? { ...m, text: e.text || m.text, streaming: false, isError: e.isError } : m)), true);
          finishBusy(e.id);
        } else if (e.type === "search") {
          const entry = { query: e.query, results: e.results };
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, searches: [...(m.searches ?? []), entry] } : m)));
        } else if (e.type === "link_proposal") {
          onLinkProposal.current?.(e);
        } else if (e.type === "question") {
          // The question belongs to the turn being answered.
          const key = (busyId.current && idToKey.current.get(busyId.current)) || currentKey.current || undefined;
          if (key) idToKey.current.set(e.id, key);
          update(key, (ms) => [...ms, { id: e.id, role: "claude", text: "", question: { question: e.question, choices: e.choices } }], true);
        } else if (e.type === "error") {
          update(e.id ? idToKey.current.get(e.id) : undefined, (ms) => ms.map((m) => (m.id === e.id ? { ...m, text: e.message, streaming: false, isError: true } : m)), true);
          finishBusy(e.id);
        }
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [update]);

  const sendText = useCallback(
    (text: string, context?: string, displayText?: string) => {
      const key = currentKey.current;
      const t = key ? threads.current.get(key) : undefined;
      if (!key || !t) return;
      const id = nextId();
      idToKey.current.set(id, key);
      busyId.current = id;
      setBusy(true);
      update(key, (ms) => [...ms, { id: `${id}-u`, role: "user", text: displayText ?? text }, { id, role: "claude", text: "", streaming: true }], true);
      claudeApi.send(t.slug, id, text, context, t.thread, t.sessionId).catch((e) => {
        update(key, (ms) => ms.map((m) => (m.id === id ? { ...m, text: String(e), streaming: false, isError: true } : m)), true);
        finishBusy(id);
      });
    },
    [update],
  );

  const answerQuestion = useCallback(
    (questionId: string, choice: string) => {
      update(currentKey.current ?? undefined, (ms) => ms.map((m) => (m.id === questionId && m.question ? { ...m, question: { ...m.question, answered: choice } } : m)), true);
    },
    [update],
  );

  const interrupt = useCallback(() => {
    void claudeApi.interrupt();
    const id = busyId.current;
    if (id) {
      update(idToKey.current.get(id), (ms) => ms.map((m) => (m.id === id ? { ...m, streaming: false } : m)), true);
      finishBusy(id);
    }
  }, [update]);

  /** Clears the current thread only (its file and its Claude session). */
  const reset = useCallback(async () => {
    const key = currentKey.current;
    const t = key ? threads.current.get(key) : undefined;
    if (!key || !t) return;
    clearTimeout(saveTimers.current.get(key));
    await api.resetChat(t.slug, t.thread);
    t.messages = [];
    t.sessionId = undefined;
    if (currentKey.current === key) setMessages([]);
  }, []);

  return { status, refreshStatus, messages, busy, sendText, answerQuestion, interrupt, reset };
}

export type ClaudeChat = ReturnType<typeof useClaudeChat>;
