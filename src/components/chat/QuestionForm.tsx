import { useState } from "react";
import { type ChatMessage } from "../../state/useClaudeChat";

const OTHER = "\u0000other";

/**
 * A question form: every question with its chips (recommended first), "Other…" and Skip, sent
 * as one reply. Read-only once sent, showing what was chosen.
 */
export function QuestionForm({ message, onSend }: { message: ChatMessage; onSend: (answers: Record<string, string | undefined>) => void }) {
  const qs = message.questions!;
  const done = !!message.answered;
  const [pick, setPick] = useState<Record<string, string | undefined>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const value = (id: string) => (pick[id] === OTHER ? other[id]?.trim() || undefined : pick[id]);
  const ready = qs.every((q) => skip[q.id] || !!value(q.id));
  const submit = () => {
    if (!done && ready) onSend(Object.fromEntries(qs.map((q) => [q.id, skip[q.id] ? undefined : value(q.id)])));
  };
  const choose = (id: string, c: string | undefined) => {
    setPick((p) => ({ ...p, [id]: c }));
    setSkip((s) => ({ ...s, [id]: false }));
  };
  return (
    <div
      className="msg claude question-form"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      {qs.map((q) => {
        const choices = q.recommended ? [q.recommended, ...q.choices.filter((c) => c !== q.recommended)] : q.choices;
        // Sent: the chosen chip, or the Other text; live: this form's picks.
        const chosen = done ? (q.answer && choices.includes(q.answer) ? q.answer : q.answer ? OTHER : undefined) : pick[q.id];
        const skipped = done ? !!q.skipped : !!skip[q.id];
        return (
          <fieldset key={q.id} className={"question" + (skipped ? " skipped" : "")} disabled={done}>
            <legend>{q.question}</legend>
            {q.context && <div className="question-context">{q.context}</div>}
            <div className="chips question-chips" role="radiogroup" aria-label={q.question}>
              {choices.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={chosen === c} className={"chip" + (chosen === c ? " on" : "")} onClick={() => choose(q.id, c)}>
                  {c}
                  {c === q.recommended && <span className="rec-tag">Recommended</span>}
                </button>
              ))}
              <button type="button" role="radio" aria-checked={chosen === OTHER} className={"chip" + (chosen === OTHER ? " on" : "")} onClick={() => choose(q.id, OTHER)}>
                {done && chosen === OTHER ? q.answer : "Other…"}
              </button>
              {!done && (
                <button type="button" className="link-btn question-skip" aria-pressed={skipped} onClick={() => setSkip((s) => ({ ...s, [q.id]: !s[q.id] }))}>
                  {skipped ? "Skipped" : "Skip"}
                </button>
              )}
              {done && skipped && <span className="question-context">Skipped</span>}
            </div>
            {!done && chosen === OTHER && (
              <input
                className="question-other"
                autoFocus
                aria-label="Your answer"
                value={other[q.id] ?? ""}
                onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    choose(q.id, OTHER);
                  }
                }}
              />
            )}
          </fieldset>
        );
      })}
      {!done && (
        <button type="button" className="btn primary question-send" disabled={!ready} onClick={submit} title="Send the answers (Ctrl+Enter)">
          Send
        </button>
      )}
    </div>
  );
}
