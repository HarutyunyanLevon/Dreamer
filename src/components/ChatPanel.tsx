import { useEffect, useRef, useState } from "react";
import type { Card } from "../api";
import { useClaudeChat, type ChatMessage } from "../state/useClaudeChat";
import type { Workspace } from "../state/useWorkspace";
import { STAGE_LABEL } from "../theme/types";
import { IconSend } from "./Icons";

const CHIPS = ["/grill-me", "Suggest links", "Summarize", "Give me 3 takes"];

function formatContext(ws: Workspace, card: Card | null): string | undefined {
  const projectName = ws.data?.meta.name;
  if (!card) return projectName ? `Project: ${projectName}` : undefined;
  const others = (ws.data?.cards ?? []).filter((c) => c.id !== card.id && !c.ghost).slice(0, 24).map((c) => c.title);
  const lines = [
    `Context: card "${card.title}" (stage: ${card.stage}${card.tags.length ? `, tags: ${card.tags.join(", ")}` : ""})`,
    card.body || "(no notes yet)",
  ];
  if (others.length) lines.push(`Other cards in "${projectName}": ${others.join(", ")}`);
  return lines.join("\n");
}

export function ChatPanel({ ws }: { ws: Workspace }) {
  const chat = useClaudeChat();
  const [text, setText] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const contextCard = ws.data?.cards.find((c) => c.id === ws.contextCardId) ?? null;

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [chat.messages]);

  if (chat.status && !chat.status.installed) {
    return (
      <aside className="glass chat" aria-label="Claude chat">
        <header className="chat-head">
          <div className="orb" aria-hidden="true" />
          <div>
            <div className="chat-title">Claude</div>
            <div className="chat-sub">Not connected</div>
          </div>
        </header>
        <div className="chat-body setup-screen">
          <p>Dreamer talks to Claude through your local Claude Code install — no API key needed.</p>
          <p>To connect: install Claude Code, then sign in once from a terminal.</p>
          <code>npm install -g @anthropic-ai/claude-code</code>
          <code>claude</code>
          <p className="chat-sub">Restart Dreamer afterwards; this panel checks again automatically.</p>
        </div>
      </aside>
    );
  }

  const send = (value: string) => {
    const v = value.trim();
    if (!v || !ws.active || chat.busy) return;
    chat.sendText(ws.active, v, formatContext(ws, contextCard));
    setText("");
  };

  const answer = (m: ChatMessage, choice: string) => {
    chat.answerQuestion(m.id, choice);
    if (contextCard) {
      void ws.updateCard(contextCard.id, { body: `${contextCard.body}${contextCard.body ? "\n\n" : ""}**Q:** ${m.question!.question}\n**A:** ${choice}` });
    }
    send(choice);
  };

  return (
    <aside className="glass chat" aria-label="Claude chat">
      <header className="chat-head">
        <div className="orb" aria-hidden="true" />
        <div>
          <div className="chat-title">Claude</div>
          <div className="chat-sub">{contextCard ? `About "${contextCard.title}" · ${STAGE_LABEL[contextCard.stage]}` : "Your idea partner"}</div>
        </div>
        {contextCard && (
          <button type="button" className="chip context-clear" onClick={() => ws.setContextCard(null)}>
            Clear
          </button>
        )}
      </header>

      <div className="chat-body" ref={bodyRef}>
        {chat.messages.length === 0 && (
          <div className="msg claude">Hi! Pick a card and I can suggest links, grill you about it, or give you a few different takes.</div>
        )}
        {chat.messages.map((m) => (
          <ChatBubble key={m.id} message={m} onAnswer={(choice) => answer(m, choice)} />
        ))}
      </div>

      <div className="chips">
        {CHIPS.map((c) => (
          <button key={c} type="button" className="chip" disabled={chat.busy || !ws.active} onClick={() => send(c)}>
            {c}
          </button>
        ))}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input aria-label="Message Claude" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Claude about this card…" disabled={chat.busy || !ws.active} />
        {chat.busy ? (
          <button type="button" className="send" aria-label="Stop" onClick={chat.interrupt}>
            ■
          </button>
        ) : (
          <button type="submit" className="send" aria-label="Send" disabled={!text.trim() || !ws.active}>
            <IconSend />
          </button>
        )}
      </form>
    </aside>
  );
}

function ChatBubble({ message, onAnswer }: { message: ChatMessage; onAnswer: (choice: string) => void }) {
  if (message.question) {
    return (
      <div className="msg claude">
        {message.question.question}
        <div className="chips question-chips">
          {message.question.choices.map((c) => (
            <button key={c} type="button" className={"chip" + (message.question!.answered === c ? " on" : "")} disabled={!!message.question!.answered} onClick={() => onAnswer(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className={"msg" + (message.role === "claude" ? " claude" : " user") + (message.isError ? " error" : "")}>
      {message.text || (message.streaming ? "…" : "")}
    </div>
  );
}
