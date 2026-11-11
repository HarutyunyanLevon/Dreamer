import { useCallback, useEffect, useRef, useState } from "react";
import { claudeApi, type ClaudeEvent, type ClaudeStatus, type SearchResultRef } from "../api/claudeIndex";

let seq = 0;
const nextId = () => `c${Date.now()}-${++seq}`;

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

export function useClaudeChat(opts: { onLinkProposal?: (p: LinkProposal) => void } = {}) {
  const onLinkProposal = useRef(opts.onLinkProposal);
  onLinkProposal.current = opts.onLinkProposal;
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const busyId = useRef<string | null>(null);

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

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    claudeApi
      .onEvent((e) => {
        if (e.type === "delta") {
          setMessages((prev) => prev.map((m) => (m.id === e.id ? { ...m, text: m.text + e.text } : m)));
        } else if (e.type === "message_done") {
          setMessages((prev) => prev.map((m) => (m.id === e.id ? { ...m, text: e.text || m.text, streaming: false, isError: e.isError } : m)));
          if (busyId.current === e.id) {
            busyId.current = null;
            setBusy(false);
          }
        } else if (e.type === "search") {
          const entry = { query: e.query, results: e.results };
          setMessages((prev) => prev.map((m) => (m.id === e.id ? { ...m, searches: [...(m.searches ?? []), entry] } : m)));
        } else if (e.type === "link_proposal") {
          onLinkProposal.current?.(e);
        } else if (e.type === "question") {
          setMessages((prev) => [...prev, { id: e.id, role: "claude", text: "", question: { question: e.question, choices: e.choices } }]);
        } else if (e.type === "error") {
          setMessages((prev) => prev.map((m) => (m.id === e.id ? { ...m, text: e.message, streaming: false, isError: true } : m)));
          if (e.id && busyId.current === e.id) {
            busyId.current = null;
            setBusy(false);
          }
        }
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unsub?.();
    };
  }, []);

  const sendText = useCallback((slug: string, text: string, context?: string, displayText?: string) => {
    const id = nextId();
    busyId.current = id;
    setBusy(true);
    setMessages((prev) => [...prev, { id: `${id}-u`, role: "user", text: displayText ?? text }, { id, role: "claude", text: "", streaming: true }]);
    claudeApi.send(slug, id, text, context).catch((e) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: String(e), streaming: false, isError: true } : m)));
      setBusy(false);
      busyId.current = null;
    });
  }, []);

  const answerQuestion = useCallback((questionId: string, choice: string) => {
    setMessages((prev) => prev.map((m) => (m.id === questionId && m.question ? { ...m, question: { ...m.question, answered: choice } } : m)));
  }, []);

  const interrupt = useCallback(() => {
    void claudeApi.interrupt();
    if (busyId.current) {
      setMessages((prev) => prev.map((m) => (m.id === busyId.current ? { ...m, streaming: false } : m)));
      busyId.current = null;
      setBusy(false);
    }
  }, []);

  return { status, refreshStatus, messages, busy, sendText, answerQuestion, interrupt };
}

export type ClaudeChat = ReturnType<typeof useClaudeChat>;
