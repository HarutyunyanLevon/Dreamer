import { useCallback, useEffect, useRef, useState } from "react";
import { api, type OrganizePlanData } from "../api";
import { claudeApi, type ClaudeEvent, type ClaudeStatus, type SearchResultRef } from "../api/claudeIndex";
import type { ActivityStep, Backend, LocalFallback, ModelTier, RouteReason, TokenUsage } from "../api/claude";
import { artifactRuns } from "./artifactRuns";

let seq = 0;
const nextId = () => `c${Date.now()}-${++seq}`;
const SAVE_DEBOUNCE_MS = 400;
/** Thinking text kept per step in the thread file. */
const THINKING_KEEP = 2000;
const DEFAULT_CONTEXT_WINDOW = 200000;

/** Inserts or updates a step by sid (keeping thinking text already streamed). */
function upsertStep(steps: ActivityStep[] | undefined, s: ActivityStep): ActivityStep[] {
  const list = steps ?? [];
  const i = list.findIndex((x) => x.sid === s.sid);
  if (i < 0) return [...list, s];
  const next = list.slice();
  next[i] = { ...list[i], ...s, text: list[i].text };
  return next;
}

/** Closes steps still running (the turn ended, failed or was stopped). */
function closeSteps(steps: ActivityStep[] | undefined, status: "done" | "error"): ActivityStep[] | undefined {
  if (!steps?.some((s) => s.status === "running")) return steps;
  const now = Date.now();
  return steps.map((s) => (s.status === "running" ? { ...s, status, endedAt: now } : s));
}

/** What a finished turn's steps keep in the thread file. */
const trimThinking = (steps: ActivityStep[] | undefined) => steps?.map((s) => (s.text && s.text.length > THINKING_KEEP ? { ...s, text: `${s.text.slice(0, THINKING_KEEP)}…` } : s));

/** The thread's context size after its last turn (header meter). */
export interface ThreadContext {
  tokens: number;
  window: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "claude";
  text: string;
  streaming?: boolean;
  isError?: boolean;
  /** `item`: the handoff gap item it settles (gap interview: the answer goes to the Tech or Project decisions card). */
  question?: { question: string; choices: string[]; answered?: string; item?: string };
  /** search_cards calls Claude made while writing this reply (shown as result chips). */
  searches?: { query: string; results: SearchResultRef[] }[];
  /** propose_edit calls: the proposal itself lives on the card (badge + diff); this is a pointer. */
  proposals?: { card: string; title: string }[];
  /** A propose_organize plan (the OrganizePlan card); `checked` = which ops are on. */
  organize?: { plan: OrganizePlanData; status: "open" | "applied" | "discarded" | "replaced"; checked: boolean[] };
  /** This turn was an organize request: what to send again for Redo / a revision. */
  organizeReq?: OrganizeReq;
  /** Pages Claude fetched with WebFetch this turn ("Save as clip"). */
  fetched?: { url: string; saved?: boolean }[];
  /** "compacted": a faint divider where the thread was summarized into a fresh session (text is empty). */
  kind?: "compacted";
  at?: string;
  summary?: string;
  /** A /grill-me turn: show only a typing indicator while streaming, never the streamed text. */
  quiet?: boolean;
  /** "Memory updated" line under this turn: what the memory pass (or remember/forget) changed. `ats` = memory log entries; `card` = decisions drafted onto the card. */
  memory?: { label: string; ats: string[]; card?: { id: string; title: string; lines: string[] } | null; undone?: boolean };
  /** An artifact turn paused at the credit cap: "Generate N more (~X credits)?" */
  creditAsk?: { reqId: string; used: number; cap: number; more: number; estCredits: number | null; answered?: "yes" | "no" };
  /** An artifact turn whose session couldn't reach SpriteCook (no key / unreachable): images were skipped. */
  spritecookNote?: "no_key" | "unreachable";
  /** An artifact turn: which artifact, and what it spent. */
  artifact?: { id: string; credits?: number; paidCalls?: number };
  /** The sidecar died (or was restarted) while this reply was streaming: shown as a red line with Retry. */
  failure?: { code: number | null; details: string[]; restarted?: boolean };
  /** What Claude did this turn (tool calls, thinking), live while it runs. */
  steps?: ActivityStep[];
  /** The turn's tokens (live while it runs, final after). */
  usage?: TokenUsage;
  durationMs?: number;
  /** The model that answered (full id) and, if a fast turn was retried, the one it started on. */
  model?: string;
  tier?: ModelTier;
  retried?: boolean;
  retriedFrom?: string;
  /** Where the turn ran (local model or Claude); `escalated`: a one-turn Claude visit from a local thread. */
  backend?: Backend;
  escalated?: boolean;
  /** Why it went to Claude instead of the local model; `routeNote`: what was wrong with Ollama. */
  routeReason?: RouteReason | null;
  routeNote?: string | null;
  /** A local turn that failed: the reply offers "Retry with Claude". */
  fallback?: LocalFallback;
  // ---- transient (never saved) ----
  /** When the turn was sent / when its last activity event arrived (ms): elapsed time and stall warning. */
  startedAt?: number;
  lastEventAt?: number;
  /** Tokens of the thread summary that ran before this turn. */
  compactUsage?: TokenUsage;
  /** The memory pass after this turn is running: its tokens so far. */
  memoryBusy?: { input: number; output: number };
}

const TRANSIENT: (keyof ChatMessage)[] = ["streaming", "startedAt", "lastEventAt", "compactUsage", "memoryBusy"];

/** An organize turn: its scope, the user's optional instruction, and a backend they forced (Redo). */
export interface OrganizeReq {
  scope: "folder" | "project";
  instruction: string;
  backend?: Backend | null;
}

type SendOpts = { quiet?: boolean; web?: boolean; selection?: string[]; folder?: string | null; memory?: boolean; question?: string; think?: boolean; pin?: ModelTier | null; escalate?: "retry"; organize?: OrganizeReq; artifact?: string; recapFrom?: string };
type ArtifactEscalation = Extract<ClaudeEvent, { type: "artifact_escalate" }>;

type LinkProposal = Extract<ClaudeEvent, { type: "link_proposal" }>;

/** One chat thread: the selected card's, or the project's when no card is selected. */
interface Thread {
  slug: string;
  thread: string;
  messages: ChatMessage[];
  /** The thread's Claude session (used when local chat is off or unavailable). */
  sessionId?: string;
  /** The thread's local-model session (Ollama). */
  localSessionId?: string;
  context?: ThreadContext;
  loaded: boolean;
  /** Settles once the thread file has been read (so a first send can resume its session). */
  loading?: Promise<void>;
}

const keyOf = (slug: string, thread: string) => `${slug}/${thread}`;

/**
 * Chat state, one thread per card (keyed by card id) plus a project-level thread. Threads are
 * loaded from and saved to `<project>/chats/<thread>.json`; each keeps its Claude session id so
 * the sidecar can resume it. Events are routed to their thread by message id, so a reply keeps
 * landing in the right thread even if the user selects another card meanwhile.
 */
export function useClaudeChat(opts: { slug: string | null; thread: string; onLinkProposal?: (p: LinkProposal) => void; onArtifactEscalate?: (e: ArtifactEscalation, from: { slug: string; thread: string }) => void }) {
  const { slug, thread } = opts;
  const onLinkProposal = useRef(opts.onLinkProposal);
  onLinkProposal.current = opts.onLinkProposal;
  const onArtifactEscalate = useRef(opts.onArtifactEscalate);
  onArtifactEscalate.current = opts.onArtifactEscalate;
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState<ThreadContext | null>(null);
  const busyId = useRef<string | null>(null);
  const threads = useRef(new Map<string, Thread>());
  const idToKey = useRef(new Map<string, string>());
  const currentKey = useRef<string | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** What each turn sent (by reply id), so Retry can send exactly the same turn again. */
  const sentArgs = useRef(new Map<string, { text: string; context?: string; displayText?: string; opts?: SendOpts }>());

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
        const messages = t.messages.map((m) => {
          const out = { ...m };
          for (const k of TRANSIENT) delete out[k];
          return out;
        });
        api.saveChat(t.slug, t.thread, { version: 1, sessionId: t.sessionId, localSessionId: t.localSessionId, messages }).catch(() => {});
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
      setContext(null);
      return;
    }
    const key = keyOf(slug, thread);
    currentKey.current = key;
    const cached = threads.current.get(key);
    if (cached) {
      setMessages(cached.messages);
      setContext(cached.context ?? null);
      return;
    }
    const t: Thread = { slug, thread, messages: [], loaded: false };
    threads.current.set(key, t);
    setMessages([]);
    setContext(null);
    t.loading = api
      .loadChat(slug, thread)
      .then((file) => {
        t.messages = [...(Array.isArray(file.messages) ? (file.messages as ChatMessage[]) : []), ...t.messages];
        t.sessionId = file.sessionId ?? t.sessionId;
        t.localSessionId = file.localSessionId ?? t.localSessionId;
        if (!t.context && typeof file.last_input_tokens === "number" && file.last_input_tokens > 0) {
          t.context = { tokens: file.last_input_tokens, window: file.context_window || DEFAULT_CONTEXT_WINDOW };
        }
      })
      .catch(() => {})
      .finally(() => {
        t.loaded = true;
        if (currentKey.current === key) {
          setMessages(t.messages);
          setContext(t.context ?? null);
        }
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
        const at = Date.now();
        if (e.type === "delta") {
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, text: m.text + e.text, lastEventAt: at } : m)));
        } else if (e.type === "step") {
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, steps: upsertStep(m.steps, e.step), lastEventAt: at } : m)));
        } else if (e.type === "thinking_delta") {
          update(idToKey.current.get(e.id), (ms) =>
            ms.map((m) => (m.id === e.id ? { ...m, steps: m.steps?.map((s) => (s.sid === e.sid ? { ...s, text: (s.text ?? "") + e.text } : s)), lastEventAt: at } : m)),
          );
        } else if (e.type === "usage") {
          const u = { input: e.input, cacheRead: e.cacheRead, cacheCreate: e.cacheCreate, output: e.output, ...(e.calls ? { calls: e.calls } : {}) };
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, ...(e.phase === "compact" ? { compactUsage: u } : { usage: u }), lastEventAt: at } : m)));
        } else if (e.type === "model_note") {
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, model: e.model, retried: e.retried, retriedFrom: e.from, lastEventAt: at } : m)));
        } else if (e.type === "route") {
          update(
            idToKey.current.get(e.id),
            (ms) => ms.map((m) => (m.id === e.id ? { ...m, backend: e.backend, model: e.model, escalated: e.escalated, routeReason: e.reason ?? null, routeNote: e.note ?? null, lastEventAt: at } : m)),
            true,
          );
        } else if (e.type === "memory_progress") {
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, memoryBusy: e.active ? { input: e.input, output: e.output } : undefined } : m)));
        } else if (e.type === "message_done") {
          const key = idToKey.current.get(e.id);
          const t = key ? threads.current.get(key) : undefined;
          // An escalation ran in a throwaway Claude session: the thread keeps its own session and context.
          if (t && e.sessionId && !e.escalated) {
            if (e.backend === "local") t.localSessionId = e.sessionId;
            else t.sessionId = e.sessionId;
          }
          const tokens = e.escalated ? 0 : e.contextTokens ?? e.inputTokens;
          if (t && tokens) {
            t.context = { tokens, window: e.contextWindow || t.context?.window || DEFAULT_CONTEXT_WINDOW };
            if (key === currentKey.current) setContext(t.context);
          }
          update(
            key,
            (ms) =>
              ms.map((m) =>
                m.id === e.id
                  ? {
                      ...m,
                      text: m.question ? "" : e.text || m.text,
                      streaming: false,
                      isError: e.isError,
                      steps: trimThinking(closeSteps(m.steps, e.isError ? "error" : "done")),
                      usage: e.usage ?? m.usage,
                      durationMs: e.durationMs ?? (m.startedAt ? at - m.startedAt : undefined),
                      // A local turn keeps the model name from its route event (the plain Ollama name).
                      model: m.backend === "local" ? m.model ?? e.model : e.model ?? m.model,
                      tier: e.tier ?? m.tier,
                      backend: e.backend ?? m.backend,
                      ...(e.fallback ? { fallback: e.fallback } : {}),
                      ...(e.artifact ? { artifact: { id: e.artifact.id, credits: e.artifact.credits, paidCalls: e.artifact.paidCalls } } : {}),
                      ...(e.retried ? { retried: true, retriedFrom: e.retriedFrom } : {}),
                    }
                  : m,
              ),
            true,
          );
          finishBusy(e.id);
        } else if (e.type === "compacted") {
          // Insert the divider just above the message that triggered it; the old session is gone.
          const key = idToKey.current.get(e.id);
          const t = key ? threads.current.get(key) : undefined;
          if (t) {
            if (e.backend === "local") t.localSessionId = undefined;
            else t.sessionId = undefined;
            t.context = t.context ? { ...t.context, tokens: 0 } : undefined;
            if (key === currentKey.current) setContext(t.context ?? null);
          }
          const divider: ChatMessage = { id: `${e.id}-c`, role: "claude", kind: "compacted", text: "", at: new Date().toISOString(), summary: e.summary };
          update(
            key,
            (ms) => {
              const i = ms.findIndex((m) => m.id === `${e.id}-u`);
              return i < 0 ? [...ms, divider] : [...ms.slice(0, i), divider, ...ms.slice(i)];
            },
            true,
          );
        } else if (e.type === "search") {
          const entry = { query: e.query, results: e.results };
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, searches: [...(m.searches ?? []), entry] } : m)));
        } else if (e.type === "edit_proposal" && e.id) {
          const p = { card: e.card, title: e.title };
          update(idToKey.current.get(e.id), (ms) => ms.map((m) => (m.id === e.id ? { ...m, proposals: [...(m.proposals ?? []).filter((x) => x.card !== p.card), p] } : m)), true);
        } else if (e.type === "organize_proposal" && e.id) {
          // A new plan replaces the thread's earlier open ones (a revision continues the same plan).
          const plan = e.plan;
          update(
            idToKey.current.get(e.id),
            (ms) =>
              ms.map((m) =>
                m.id === e.id
                  ? { ...m, organize: { plan, status: "open", checked: plan.ops.map(() => true) } }
                  : m.organize?.status === "open"
                    ? { ...m, organize: { ...m.organize, status: "replaced" } }
                    : m,
              ),
            true,
          );
        } else if (e.type === "memory_update") {
          update(
            idToKey.current.get(e.id),
            (ms) =>
              ms.map((m) => {
                if (m.id !== e.id) return m;
                const prev = m.memory && !m.memory.undone ? m.memory : null;
                const card = e.card ? { ...e.card, lines: [...(prev?.card?.id === e.card.id ? prev.card.lines : []), ...e.card.lines] } : prev?.card ?? null;
                return { ...m, memory: { label: [prev?.label, e.label].filter(Boolean).join(" · "), ats: [...(prev?.ats ?? []), ...e.ats], card } };
              }),
            true,
          );
        } else if (e.type === "web_fetch") {
          update(
            idToKey.current.get(e.id),
            (ms) => ms.map((m) => (m.id === e.id && !m.fetched?.some((f) => f.url === e.url) ? { ...m, fetched: [...(m.fetched ?? []), { url: e.url }] } : m)),
            true,
          );
        } else if (e.type === "link_proposal") {
          onLinkProposal.current?.(e);
        } else if (e.type === "credit_confirm") {
          const ask = { reqId: e.reqId, used: e.used, cap: e.cap, more: e.more, estCredits: e.estCredits };
          update(e.id ? idToKey.current.get(e.id) : undefined, (ms) => ms.map((m) => (m.id === e.id ? { ...m, creditAsk: ask, lastEventAt: at } : m)), true);
        } else if (e.type === "credit_answered") {
          update(e.id ? idToKey.current.get(e.id) : undefined, (ms) => ms.map((m) => (m.id === e.id && m.creditAsk?.reqId === e.reqId ? { ...m, creditAsk: { ...m.creditAsk, answered: e.allow ? "yes" : "no" } } : m)), true);
        } else if (e.type === "spritecook_status" && !e.ok && e.reason) {
          const reason = e.reason;
          update(e.id ? idToKey.current.get(e.id) : undefined, (ms) => ms.map((m) => (m.id === e.id ? { ...m, spritecookNote: reason } : m)), true);
        } else if (e.type === "artifact_escalate") {
          const key = e.id ? idToKey.current.get(e.id) : undefined;
          const t = key ? threads.current.get(key) : undefined;
          if (t) onArtifactEscalate.current?.(e, { slug: t.slug, thread: t.thread });
        } else if (e.type === "question") {
          // Attach the question to the reply it belongs to: that reply then renders only as the
          // question card, so the question never appears twice (as streamed text and as a card).
          const turn = e.turnId ?? busyId.current;
          const key = (turn && idToKey.current.get(turn)) || currentKey.current || undefined;
          const q = { question: e.question, choices: e.choices, ...(e.item ? { item: e.item } : {}) };
          update(
            key,
            (ms) => (turn && ms.some((m) => m.id === turn) ? ms.map((m) => (m.id === turn ? { ...m, text: "", question: q } : m)) : [...ms, { id: e.id, role: "claude", text: "", question: q }]),
            true,
          );
        } else if (e.type === "sidecar_exit") {
          // Nothing more will arrive for any reply still streaming: fail them all, in every thread.
          const failure = { code: e.code, details: e.lastStderr ?? [], restarted: !!e.restarted };
          for (const key of threads.current.keys()) {
            const t = threads.current.get(key);
            if (!t?.messages.some((m) => m.streaming && m.id !== e.keep)) continue;
            update(key, (ms) => ms.map((m) => (m.streaming && m.id !== e.keep ? { ...m, streaming: false, isError: true, failure, steps: trimThinking(closeSteps(m.steps, "error")) } : m)), true);
          }
          if (busyId.current && busyId.current !== e.keep) finishBusy(busyId.current);
        } else if (e.type === "error") {
          update(e.id ? idToKey.current.get(e.id) : undefined, (ms) => ms.map((m) => (m.id === e.id ? { ...m, text: e.message, streaming: false, isError: true, steps: trimThinking(closeSteps(m.steps, "error")) } : m)), true);
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
    (text: string, context?: string, displayText?: string, opts?: SendOpts) => {
      const key = currentKey.current;
      const t = key ? threads.current.get(key) : undefined;
      if (!key || !t) return;
      const id = nextId();
      idToKey.current.set(id, key);
      sentArgs.current.set(id, { text, context, displayText, opts });
      busyId.current = id;
      setBusy(true);
      const now = Date.now();
      update(key, (ms) => [...ms, { id: `${id}-u`, role: "user", text: displayText ?? text }, { id, role: "claude", text: "", streaming: true, quiet: opts?.quiet, startedAt: now, lastEventAt: now, ...(opts?.organize ? { organizeReq: opts.organize } : {}), ...(opts?.artifact ? { artifact: { id: opts.artifact } } : {}) }], true);
      if (opts?.artifact) artifactRuns.start(opts.artifact, id);
      // A thread opened a moment ago (e.g. from the canvas context menu) may still be loading.
      Promise.resolve(t.loaded ? undefined : t.loading).then(() => claudeApi.send(t.slug, id, text, context, t.thread, t.sessionId, { web: opts?.web, selection: opts?.selection, folder: opts?.folder, memory: opts?.memory, question: opts?.question, think: opts?.think, pin: opts?.pin, resumeLocal: t.localSessionId, escalate: opts?.escalate, organize: opts?.organize?.scope, organizeBackend: opts?.organize?.backend ?? null, artifact: opts?.artifact ?? null, recapFrom: opts?.recapFrom ?? null })).catch((e) => {
        update(key, (ms) => ms.map((m) => (m.id === id ? { ...m, text: String(e), streaming: false, isError: true } : m)), true);
        finishBusy(id);
      });
    },
    [update],
  );

  /**
   * Retry a failed reply: drops it and its user message, then sends the same turn again (the
   * backend starts a fresh sidecar if the old one is gone). False when this session never sent it
   * (e.g. it failed before an app restart); the caller then resends the visible text.
   */
  const retry = useCallback(
    (replyId: string) => {
      const key = currentKey.current;
      const args = sentArgs.current.get(replyId);
      if (!key || busyId.current) return true; // busy: nothing to do now
      if (!args) return false;
      update(key, (ms) => ms.filter((m) => m.id !== replyId && m.id !== `${replyId}-u`), true);
      sendText(args.text, args.context, args.displayText, args.opts);
      return true;
    },
    [update, sendText],
  );

  /**
   * "Retry with Claude" on a failed local turn: drops it and its user message, then sends the same
   * turn to Claude once (with the local model's recap of the thread). The next turn is local again.
   */
  const retryWithClaude = useCallback(
    (replyId: string) => {
      const key = currentKey.current;
      if (!key || busyId.current) return;
      const t = threads.current.get(key);
      const args = sentArgs.current.get(replyId);
      const user = t?.messages.find((m) => m.id === `${replyId}-u`);
      if (!args && !user) return;
      update(key, (ms) => ms.filter((m) => m.id !== replyId && m.id !== `${replyId}-u`), true);
      if (args) sendText(args.text, args.context, args.displayText, { ...args.opts, escalate: "retry" });
      else sendText(user!.text, undefined, undefined, { escalate: "retry" });
    },
    [update, sendText],
  );

  const answerQuestion = useCallback(
    (questionId: string, choice: string) => {
      update(currentKey.current ?? undefined, (ms) => ms.map((m) => (m.id === questionId && m.question ? { ...m, question: { ...m.question, answered: choice } } : m)), true);
    },
    [update],
  );

  /** Updates a plan card: its status or which ops are checked (kept in the thread file). */
  const setOrganize = useCallback(
    (messageId: string, patch: Partial<{ status: "open" | "applied" | "discarded" | "replaced"; checked: boolean[] }>) => {
      update(currentKey.current ?? undefined, (ms) => ms.map((m) => (m.id === messageId && m.organize ? { ...m, organize: { ...m.organize, ...patch } } : m)), true);
    },
    [update],
  );

  /** Answers a paused artifact turn's credit confirm. */
  const answerCredit = useCallback(
    (messageId: string, allow: boolean) => {
      const key = currentKey.current ?? undefined;
      const t = key ? threads.current.get(key) : undefined;
      const ask = t?.messages.find((m) => m.id === messageId)?.creditAsk;
      if (!ask || ask.answered) return;
      update(key, (ms) => ms.map((m) => (m.id === messageId && m.creditAsk ? { ...m, creditAsk: { ...m.creditAsk, answered: allow ? "yes" : "no" } } : m)), true);
      void claudeApi.creditAnswer(ask.reqId, allow);
    },
    [update],
  );

  /** Marks a fetched page as saved as a clip (kept in the thread file). */
  const markFetchSaved = useCallback(
    (messageId: string, url: string) => {
      update(currentKey.current ?? undefined, (ms) => ms.map((m) => (m.id === messageId && m.fetched ? { ...m, fetched: m.fetched.map((f) => (f.url === url ? { ...f, saved: true } : f)) } : m)), true);
    },
    [update],
  );

  /** Undo on a "Memory updated" line: reverts its memory entries and removes the decisions drafted onto the card. */
  const undoMemory = useCallback(
    async (messageId: string) => {
      const key = currentKey.current;
      const t = key ? threads.current.get(key) : undefined;
      const mem = t?.messages.find((m) => m.id === messageId)?.memory;
      if (!t || !mem || mem.undone) return;
      await api.memoryUndo(t.slug, mem.ats, mem.card?.id, mem.card?.lines);
      update(key ?? undefined, (ms) => ms.map((m) => (m.id === messageId && m.memory ? { ...m, memory: { ...m.memory, undone: true } } : m)), true);
    },
    [update],
  );

  const interrupt = useCallback(
    (hard = false) => {
      void claudeApi.interrupt({ hard });
      const id = busyId.current;
      if (id) {
        update(idToKey.current.get(id), (ms) => ms.map((m) => (m.id === id ? { ...m, streaming: false, steps: trimThinking(closeSteps(m.steps, "done")) } : m)), true);
        finishBusy(id);
      }
    },
    [update],
  );

  /** Retry a stalled turn: stop it (closing its possibly wedged session), then send the same message again. */
  const retryStalled = useCallback(
    (replyId: string) => {
      if (busyId.current === replyId) interrupt(true);
      if (!retry(replyId)) {
        const t = currentKey.current ? threads.current.get(currentKey.current) : undefined;
        const user = t?.messages.find((m) => m.id === `${replyId}-u`);
        if (user) sendText(user.text);
      }
    },
    [interrupt, retry, sendText],
  );

  /** Clears the current thread only (its file and its Claude session). */
  const reset = useCallback(async () => {
    const key = currentKey.current;
    const t = key ? threads.current.get(key) : undefined;
    if (!key || !t) return;
    clearTimeout(saveTimers.current.get(key));
    await api.resetChat(t.slug, t.thread);
    t.messages = [];
    t.sessionId = undefined;
    t.localSessionId = undefined;
    t.context = undefined;
    if (currentKey.current === key) {
      setMessages([]);
      setContext(null);
    }
  }, []);

  return { status, refreshStatus, messages, busy, context, sendText, retry, retryWithClaude, retryStalled, answerQuestion, answerCredit, markFetchSaved, setOrganize, undoMemory, interrupt, reset };
}

export type ClaudeChat = ReturnType<typeof useClaudeChat>;
