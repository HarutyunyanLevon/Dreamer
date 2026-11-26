import { useEffect, useState } from "react";
import { api } from "../../api";
import { type ChatMessage } from "../../state/useClaudeChat";
import { Modal } from "../../ui/Modal";
import { Tokens, fmtTokens, modelLabel } from "../Activity";
import { type SpritecookKeyStatus } from "../../api";
import { refreshBalance, useBalance } from "../../state/artifactRuns";

export function CreditAsk({ ask, live, onAnswer }: { ask: NonNullable<ChatMessage["creditAsk"]>; live: boolean; onAnswer: (allow: boolean) => void }) {
  if (ask.answered) {
    return <div className="credit-ask done">{ask.answered === "yes" ? `Allowed ${ask.more} more paid SpriteCook calls.` : "Stopped at the credit cap."}</div>;
  }
  if (!live) return <div className="credit-ask done">Paused at the credit cap ({ask.used} of {ask.cap} paid calls).</div>;
  return (
    <div className="credit-ask" role="group" aria-label="Credit cap reached">
      <span>
        This turn used {ask.used} of {ask.cap} paid SpriteCook calls.
      </span>
      <button type="button" className="btn primary" onClick={() => onAnswer(true)}>
        Generate {ask.more} more{ask.estCredits != null ? ` (~${ask.estCredits} credits)` : ""}?
      </button>
      <button type="button" className="btn" onClick={() => onAnswer(false)}>
        Stop here
      </button>
    </div>
  );
}

/** SpriteCook credits next to the model chip; refreshed after every artifact turn, click to refresh. */
export function BalanceChip({ onSettings }: { onSettings: () => void }) {
  const b = useBalance();
  useEffect(() => {
    refreshBalance();
  }, []);
  if (b.error === "no_key") return null;
  const label = b.credits != null ? `${Math.round(b.credits).toLocaleString()} cr` : b.loading ? "…" : "–";
  return (
    <button
      type="button"
      className={"model-chip balance-chip" + (b.error ? " warn" : "")}
      title={b.error ? `SpriteCook balance unavailable: ${b.error}. Click to retry; SpriteCook settings are in Settings.` : "SpriteCook credits. Click to refresh."}
      aria-label={`SpriteCook credits: ${label}`}
      onClick={() => refreshBalance()}
      onContextMenu={(e) => {
        e.preventDefault();
        onSettings();
      }}
    >
      ◈ {label}
    </button>
  );
}

/** Under each reply: "Claude · Opus · ↑ 12k ↓ 300". */
export function ModelBadge({ message: m }: { message: ChatMessage }) {
  if (!m.model) return null;
  return (
    <div className="model-badge claude">
      Claude · {modelLabel(m.model) ?? "Claude"}
      {m.usage && (
        <>
          {" · "}
          <Tokens usage={m.usage} />
        </>
      )}
    </div>
  );
}

/** The context meter's numbers and explanation (header line and the ⋯ menu). */
export function contextTip(tokens: number, window: number, compactTokens: number) {
  const warn = compactTokens > 0 && tokens >= compactTokens * 0.8;
  const pct = Math.min(100, (tokens / Math.max(1, window)) * 100);
  const tip =
    `This thread's context: ${tokens.toLocaleString()} of ${window.toLocaleString()} tokens after the last reply.` +
    (compactTokens > 0
      ? ` When a turn's input passes ${compactTokens.toLocaleString()} tokens, Dreamer summarizes the earlier messages and continues in a fresh session (Settings › “Summarize a thread after”).`
      : " Automatic summarizing is off (Settings › “Summarize a thread after” is 0).");
  return { warn, pct, tip };
}

/** "34k / 200k" with a thin bar; amber from 80% of the auto-summary threshold. */
export function ContextMeter({ tokens, window, compactTokens }: { tokens: number; window: number; compactTokens: number }) {
  const { warn, pct, tip } = contextTip(tokens, window, compactTokens);
  return (
    <div className={"ctx-meter" + (warn ? " warn" : "")} title={tip} aria-label={tip}>
      <span className="ctx-meter-text">
        {fmtTokens(tokens)} / {fmtTokens(window)}
      </span>
      <span className="ctx-meter-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

const MODEL_SUGGESTIONS = ["sonnet", "opus", "haiku", "fable"];

/** Settings: which Claude model the chat and the handoff pack use (aliases or full model ids). */
export function ModelSettings({ onClose, onError }: { onClose: () => void; onError: (e: string) => void }) {
  const [chatModel, setChatModel] = useState<string | null>(null);
  const [exportModel, setExportModel] = useState("");
  const [router, setRouter] = useState(true);
  const [fastModel, setFastModel] = useState("");
  const [deepModel, setDeepModel] = useState("");
  const [memoryModel, setMemoryModel] = useState("");
  const [compactTokens, setCompactTokens] = useState("");
  const [memoryCap, setMemoryCap] = useState("");
  const [scUrl, setScUrl] = useState("");
  const [creditCap, setCreditCap] = useState("");
  const [scKey, setScKey] = useState<SpritecookKeyStatus | null>(null);
  const [newKey, setNewKey] = useState("");
  useEffect(() => {
    api.spritecookKeyStatus().then(setScKey).catch(() => setScKey(null));
    api
      .getSettings()
      .then((s) => {
        setChatModel(s.model_chat);
        setExportModel(s.model_export);
        setRouter(s.model_router);
        setFastModel(s.model_fast);
        setDeepModel(s.model_deep);
        setMemoryModel(s.model_memory);
        setCompactTokens(String(s.compact_tokens));
        setMemoryCap(String(s.memory_cap));
        setScUrl(s.spritecook_url);
        setCreditCap(String(s.credit_cap));
      })
      .catch((e) => onError(String(e)));
  }, [onError]);
  const save = async () => {
    try {
      await api.updateSettings({ model_chat: chatModel ?? "", model_router: router, model_fast: fastModel, model_deep: deepModel, model_export: exportModel, model_memory: memoryModel, compact_tokens: Math.max(0, Math.floor(Number(compactTokens)) || 0), memory_cap: Math.max(0, Math.floor(Number(memoryCap)) || 0), spritecook_url: scUrl, credit_cap: Math.max(0, Math.floor(Number(creditCap)) || 0) });
      if (newKey.trim()) await api.spritecookSetKey(newKey.trim());
      onClose();
    } catch (e) {
      onError(String(e));
    }
  };
  return (
    <Modal onClose={onClose} label="Claude models" size="sm">
      <h3 className="dialog-title">Settings</h3>
      <form
        className="model-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="check-row">
          <input type="checkbox" checked={router} disabled={chatModel === null} onChange={(e) => setRouter(e.target.checked)} />
          Route chat messages to the cheapest fitting model
        </label>
        <label>
          Fast (simple actions and lookups)
          <input className="name-input" list="claude-models" value={fastModel} disabled={chatModel === null || !router} placeholder="haiku" onChange={(e) => setFastModel(e.target.value)} />
        </label>
        <label>
          Main (chat)
          <input className="name-input" list="claude-models" value={chatModel ?? ""} disabled={chatModel === null} placeholder="sonnet" onChange={(e) => setChatModel(e.target.value)} />
        </label>
        <label>
          Deep (the Think button)
          <input className="name-input" list="claude-models" value={deepModel} disabled={chatModel === null} placeholder="opus" onChange={(e) => setDeepModel(e.target.value)} />
        </label>
        <label>
          Handoff pack
          <input className="name-input" list="claude-models" value={exportModel} disabled={chatModel === null} placeholder="opus" onChange={(e) => setExportModel(e.target.value)} />
        </label>
        <label>
          Thread summaries
          <input className="name-input" list="claude-models" value={memoryModel} disabled={chatModel === null} placeholder="haiku" onChange={(e) => setMemoryModel(e.target.value)} />
        </label>
        <label>
          Summarize a thread after (input tokens)
          <input className="name-input" inputMode="numeric" value={compactTokens} disabled={chatModel === null} placeholder="50000" onChange={(e) => setCompactTokens(e.target.value)} />
        </label>
        <label>
          Project memory cap (words)
          <input className="name-input" inputMode="numeric" value={memoryCap} disabled={chatModel === null} placeholder="600" onChange={(e) => setMemoryCap(e.target.value)} />
        </label>
        <h4 className="settings-sub" id="spritecook-settings">SpriteCook (artifact images)</h4>
        <label>
          API key {scKey?.hasKey ? <span className="chat-sub">saved: {scKey.masked}</span> : <span className="chat-sub">not set: themes and mockups still work, images don't</span>}
          <input className="name-input" type="password" autoComplete="off" value={newKey} placeholder={scKey?.hasKey ? "Paste a new key to replace it" : "sc_live_…"} onChange={(e) => setNewKey(e.target.value)} />
        </label>
        {scKey?.hasKey && (
          <button
            type="button"
            className="btn"
            onClick={() => api.spritecookSetKey("").then(setScKey).catch((er) => onError(String(er)))}
          >
            Remove saved key
          </button>
        )}
        <label>
          Server URL
          <input className="name-input" value={scUrl} disabled={chatModel === null} placeholder="https://api.spritecook.ai/mcp/" onChange={(e) => setScUrl(e.target.value)} />
        </label>
        <label>
          Paid SpriteCook calls per artifact turn before asking
          <input className="name-input" inputMode="numeric" value={creditCap} disabled={chatModel === null} placeholder="4" onChange={(e) => setCreditCap(e.target.value)} />
        </label>
        <p className="chat-sub">The key is kept in the Windows credential store, never in the workspace.</p>
        <datalist id="claude-models">
          {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
        </datalist>
        <p className="chat-sub">An alias (sonnet, opus, haiku, fable) or a full model id. Leave empty for the default. Applies from the next message.</p>
        <div className="editor-actions">
          <button type="button" className="btn" title="Show sidecar.log, the record of Dreamer's Claude helper (no message text)" onClick={() => api.openLogsFolder().catch((er) => onError(String(er)))}>
            Open logs folder
          </button>
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={chatModel === null}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
