import { IconSend } from "./Icons";

const CHIPS = ["/grill-me", "Suggest links", "Summarize"];

/** Static shell. Streaming chat, tools and ghost cards arrive in step 6. */
export function ChatPanel() {
  return (
    <aside className="glass chat" aria-label="Claude chat">
      <header className="chat-head">
        <div className="orb" aria-hidden="true" />
        <div>
          <div className="chat-title">Claude</div>
          <div className="chat-sub">Your idea partner</div>
        </div>
      </header>

      <div className="chat-body">
        <div className="msg claude">
          Hi! Pick a card and I can suggest links, grill you about it, or give you a few different takes.
        </div>
      </div>

      <div className="chips">
        {CHIPS.map((c) => (
          <button key={c} type="button" className="chip" disabled title="Available when Claude is connected (step 6)">
            {c}
          </button>
        ))}
      </div>

      <form className="chat-input" onSubmit={(e) => e.preventDefault()}>
        <input aria-label="Message Claude" placeholder="Ask Claude about this card…" disabled />
        <button type="submit" className="send" aria-label="Send" disabled>
          <IconSend />
        </button>
      </form>
    </aside>
  );
}
