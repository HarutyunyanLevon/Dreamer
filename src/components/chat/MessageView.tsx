import { useState } from "react";
import { type ChatMessage } from "../../state/useClaudeChat";
import { ActivitySummary, LiveActivity, fmtTokens } from "../Activity";
import { QuestionForm } from "./QuestionForm";
import { CreditAsk, ModelBadge } from "./Status";

export function ChatBubble({
  message,
  onAnswer,
  onOpenCard,
  activeProject,
  cardTitle,
  pending,
  onSaveClip,
  onUndoMemory,
  onEditMemory,
  saveTarget,
  onRetry,
  retryDisabled,
  onStop,
  onRetryStalled,
  onCredit,
  onOpenSettings,
}: {
  /** Answer a paused artifact turn's credit confirm. */
  onCredit: (allow: boolean) => void;
  onOpenSettings: () => void;
  onRetry: () => void;
  retryDisabled: boolean;
  /** Stop / Retry offered by a stalled live turn. */
  onStop: () => void;
  onRetryStalled: () => void;
  message: ChatMessage;
  onAnswer: (answers: Record<string, string | undefined>) => void;
  onOpenCard: (id: string, project: string) => void;
  activeProject: string | null;
  cardTitle: (id: string) => string | undefined;
  pending: (cardId: string) => boolean;
  onSaveClip: (url: string) => void;
  onUndoMemory: () => void;
  onEditMemory: () => void;
  saveTarget: string;
}) {
  const [showSummary, setShowSummary] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const live = message.role === "claude" && message.streaming;
  const compacting = message.steps?.some((s) => s.sid === "compact" && s.status === "running");
  const activity = live ? (
    <LiveActivity
      steps={message.steps}
      usage={compacting ? message.compactUsage : message.usage}
      startedAt={message.startedAt ?? Date.now()}
      lastEventAt={message.lastEventAt ?? message.startedAt ?? Date.now()}
      writing={!!message.text && !message.quiet}
      onStop={onStop}
      onRetry={onRetryStalled}
    />
  ) : message.role === "claude" && !message.failure ? (
    // Turns with a model show it and the tokens in the badge under the reply instead.
    <ActivitySummary
      steps={message.steps}
      usage={message.model ? undefined : message.usage}
      durationMs={message.durationMs}
      retriedFrom={message.retried ? message.retriedFrom : undefined}
    />
  ) : null;
  const badge = message.role === "claude" && !live && !message.failure && <ModelBadge message={message} />;
  const memBusy = message.memoryBusy && (
    <div className="memory-line busy" aria-live="polite">
      <span className="memory-text">
        Updating memory…{message.memoryBusy.input > 0 && <> ↑ {fmtTokens(message.memoryBusy.input)}</>}
      </span>
    </div>
  );
  if (message.kind === "compacted") {
    return (
      <button type="button" className="chat-compacted" title={message.summary || "Summary unavailable"} onClick={() => setShowSummary((v) => !v)}>
        Earlier messages summarized
        {showSummary && <span className="chat-compacted-text">{message.summary}</span>}
      </button>
    );
  }
  const mem = message.memory && (
    <div className={"memory-line" + (message.memory.undone ? " undone" : "")} aria-label="Memory update">
      <span className="memory-text">{message.memory.undone ? "Memory change undone" : `Memory updated: ${message.memory.label}`}</span>
      {!message.memory.undone && (
        <button type="button" className="memory-act" onClick={onUndoMemory}>
          Undo
        </button>
      )}
      <button type="button" className="memory-act" onClick={onEditMemory}>
        Edit memory
      </button>
    </div>
  );
  if (message.questions) {
    return (
      <>
      {activity}
      <QuestionForm message={message} onSend={onAnswer} />
      {message.creditAsk && <CreditAsk ask={message.creditAsk} live={!!live} onAnswer={onCredit} />}
      {message.spritecookNote && message.role === "claude" && (
        <div className="chat-failure sc-note" role="note">
          <div className="chat-failure-line">
            <span>{message.spritecookNote === "no_key" ? "No SpriteCook key: image steps were skipped. Themes and mockups still work as HTML." : "SpriteCook couldn't be reached: image steps were skipped."}</span>
            <button type="button" className="chip" onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </div>
      )}
      {badge}
      {memBusy}
      {mem}
      </>
    );
  }
  const showText = message.role === "user" || !!message.text;
  return (
    <>
      {message.role === "claude" && !live && activity}
      {message.searches?.map((s, i) => (
        <div key={i} className="search-trace" aria-label={`Searched cards: ${s.query}`}>
          <div className="search-trace-head">
            Searched cards: <strong>{s.query}</strong>
            {s.results.length === 0 && <span className="chat-sub"> · no matches</span>}
          </div>
          {s.results.length > 0 && (
            <div className="chips search-chips">
              {s.results.map((r) => (
                <button
                  key={`${r.project}:${r.id}`}
                  type="button"
                  className={"chip result-chip" + (r.ghost ? " ghost" : "")}
                  title={r.project === activeProject ? "Show on canvas" : `Open in ${r.projectName}`}
                  onClick={() => onOpenCard(r.id, r.project)}
                >
                  <span className={`dot dot-${r.stage}`} aria-hidden="true" />
                  {r.title}
                  {r.project !== activeProject && <span className="result-proj">{r.projectName}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {message.fetched && message.fetched.length > 0 && (
        <div className="search-trace fetch-trace" aria-label="Pages Claude read">
          <div className="search-trace-head">Read on the web</div>
          {message.fetched.map((f) => (
            <div key={f.url} className="chips search-chips">
              <span className="fetch-url" title={f.url}>{f.url.replace(/^https?:\/\//, "")}</span>
              <button type="button" className="chip" disabled={f.saved} title={f.saved ? undefined : `Save this page as a web clip on ${saveTarget}`} onClick={() => onSaveClip(f.url)}>
                {f.saved ? "Saved" : "Save as clip"}
              </button>
            </div>
          ))}
        </div>
      )}
      {message.proposals?.map((p) => (
        <div key={`prop-${p.card}`} className="search-trace">
          <div className="search-trace-head">
            Suggested changes to <strong>{cardTitle(p.card) ?? p.title}</strong>
            {pending(p.card) ? " · open the card's badge to keep or dismiss them" : " · settled"}
          </div>
          {pending(p.card) && activeProject && (
            <div className="chips search-chips">
              <button type="button" className="chip result-chip ghost" onClick={() => onOpenCard(p.card, activeProject)}>
                Show card
              </button>
            </div>
          )}
        </div>
      ))}
      {live && activity}
      {showText && !(message.quiet && live) && (
        <div className={"msg" + (message.role === "claude" ? " claude" : " user") + (message.isError && !message.failure ? " error" : "")}>
          {message.text}
        </div>
      )}
      {badge}
      {message.isError && !message.failure && !live && (
        <div className="chat-failure">
          <div className="chat-failure-line">
            <button type="button" className="chip" disabled={retryDisabled} onClick={onRetry}>
              Retry
            </button>
          </div>
        </div>
      )}
      {message.failure && (
        <div className="chat-failure" role="alert">
          <div className="chat-failure-line">
            <span>
              {message.failure.restarted ? "Claude's helper was restarted." : `Claude's helper stopped (code ${message.failure.code ?? "unknown"}).`}
            </span>
            <button type="button" className="chip" disabled={retryDisabled} onClick={onRetry}>
              Retry
            </button>
            {message.failure.details.length > 0 && (
              <button type="button" className="memory-act" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
                {showDetails ? "Hide details" : "Show details"}
              </button>
            )}
          </div>
          {showDetails && <pre className="chat-failure-details scroll scroll-x">{message.failure.details.join("\n")}</pre>}
        </div>
      )}
      {memBusy}
      {mem}
    </>
  );
}

/** "Generate N more (~X credits)?" under a paused artifact turn. */
