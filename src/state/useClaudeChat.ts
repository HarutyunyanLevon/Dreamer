import { useCallback, useEffect, useRef, useState } from "react";
import { claudeApi, type ClaudeStatus } from "../api/claudeIndex";

let seq = 0;
const nextId = () => `c${Date.now()}-${++seq}`;

export interface ChatMessage {
  id: string;
  role: "user" | "claude";
  text: string;
  streaming?: boolean;
  isError?: boolean;
  question?: { question: string; choices: string[]; answered?: string };
}

export function useClaudeChat() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const busyId = useRef<string | null>(null);

  useEffect(() => {
    claudeApi.status().then(setStatus).catch(() => setStatus({ installed: false }));
  }, []);

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

  const sendText = useCallback((slug: string, text: string, context?: string) => {
    const id = nextId();
    busyId.current = id;
    setBusy(true);
    setMessages((prev) => [...prev, { id: `${id}-u`, role: "user", text }, { id, role: "claude", text: "", streaming: true }]);
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

  return { status, messages, busy, sendText, answerQuestion, interrupt };
}

export type ClaudeChat = ReturnType<typeof useClaudeChat>;
