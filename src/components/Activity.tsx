import { useEffect, useState, type ReactNode } from "react";
import type { ActivityStep, TokenUsage } from "../api/claude";

/** Idle this long (no step, usage, text or thinking event) and the status line warns. */
export const STALL_MS = 45_000;

/** 640 · 1.2k · 12.3k · 123k · 1.2M */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "claude-haiku-4-5-20251001" -> "Haiku"; an unknown id is shown as is. */
export function modelLabel(id?: string): string | undefined {
  if (!id) return undefined;
  const m = /haiku|sonnet|opus|fable/i.exec(id);
  return m ? m[0][0].toUpperCase() + m[0].slice(1).toLowerCase() : id;
}

/** mm:ss */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 18s · 2m 05s */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Re-renders every `ms` while `active`; returns the current time. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [active, ms]);
  return now;
}

/** ↑ input (cached part muted) ↓ output */
export function Tokens({ usage }: { usage: TokenUsage }) {
  const input = usage.input + usage.cacheRead + usage.cacheCreate;
  return (
    <span className="activity-tokens" title={`Input ${input.toLocaleString()} tokens (${usage.cacheRead.toLocaleString()} read from cache), output ${usage.output.toLocaleString()}`}>
      ↑ {fmtTokens(input)}
      {usage.cacheRead > 0 && <span className="activity-cached"> ({fmtTokens(usage.cacheRead)} cached)</span>} ↓ {fmtTokens(usage.output)}
    </span>
  );
}

function StepRow({ step, now }: { step: ActivityStep; now: number }) {
  const [open, setOpen] = useState(false);
  const icon =
    step.status === "running" ? <span className="spinner activity-spin" aria-hidden="true" /> : step.status === "error" ? <span className="activity-err" aria-hidden="true" /> : <span className="activity-ok" aria-hidden="true">✓</span>;
  if (step.kind === "thinking") {
    const secs = Math.max(0, Math.round(((step.endedAt ?? now) - step.startedAt) / 1000));
    const label = step.status === "running" ? `Thinking… ${secs}s` : `Thought for ${secs}s`;
    return (
      <li className={`activity-step ${step.status}`}>
        {icon}
        <div className="activity-step-main">
          <button type="button" className="activity-think" aria-expanded={open} disabled={!step.text} onClick={() => setOpen((v) => !v)}>
            {label}
            {step.text && <span className="activity-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>}
          </button>
          {open && step.text && <div className="activity-think-text scroll scroll-y">{step.text}</div>}
        </div>
      </li>
    );
  }
  return (
    <li className={`activity-step ${step.status}`}>
      {icon}
      <div className="activity-step-main">
        <span className="activity-label">{step.label}</span>
        {step.status === "error" && step.detail && <span className="activity-detail">{step.detail}</span>}
      </div>
      <span className="sr-only">{step.status}</span>
    </li>
  );
}

/** "Call 2 · ↑ 35k (28.6k new)": one model call's whole input, so a jump in context is visible. */
function CallRow({ n, call, prev }: { n: number; call: TokenUsage; prev?: TokenUsage }) {
  const input = call.input + call.cacheRead + call.cacheCreate;
  const before = prev ? prev.input + prev.cacheRead + prev.cacheCreate : 0;
  const jump = !!prev && input - before >= 20_000 && input >= before * 2;
  return (
    <li
      className={"activity-call" + (jump ? " jump" : "")}
      title={`Input ${input.toLocaleString()} tokens: ${call.cacheRead.toLocaleString()} from cache, ${call.cacheCreate.toLocaleString()} newly cached, ${call.input.toLocaleString()} uncached. Output ${call.output.toLocaleString()}.`}
    >
      Call {n} · ↑ {fmtTokens(input)}
      {call.cacheCreate > 0 && <span className="activity-cached"> ({fmtTokens(call.cacheCreate)} new)</span>}
      {jump && <> · +{fmtTokens(input - before)} since the last call</>}
    </li>
  );
}

export function StepList({ steps, now, calls }: { steps: ActivityStep[]; now: number; calls?: TokenUsage[] }) {
  if (!steps.length && !calls?.length) return null;
  const rows: ReactNode[] = [];
  let shown = 0;
  const showCallsUpTo = (n: number) => {
    for (; calls && shown < Math.min(n, calls.length); shown++) rows.push(<CallRow key={`call${shown + 1}`} n={shown + 1} call={calls[shown]} prev={calls[shown - 1]} />);
  };
  for (const s of steps) {
    if (s.call) showCallsUpTo(s.call);
    rows.push(<StepRow key={s.sid} step={s} now={now} />);
  }
  showCallsUpTo(calls?.length ?? 0);
  return (
    <ol className="activity-steps" aria-label="What Claude did">
      {rows}
    </ol>
  );
}

/** What the status line names as happening now. */
export function currentLabel(steps: ActivityStep[] | undefined, writing: boolean, anyEvent: boolean): string {
  const running = steps?.filter((s) => s.status === "running") ?? [];
  const last = running[running.length - 1];
  if (last) return last.kind === "thinking" ? "Thinking…" : last.label;
  if (writing) return "Writing…";
  return anyEvent ? "Working…" : "Waiting for Claude…";
}

/**
 * The live view of a running turn or job: its steps, then a status line (current step · elapsed ·
 * tokens). After STALL_MS without an event the line turns amber with Stop / Retry (when given).
 */
export function LiveActivity({
  steps,
  usage,
  startedAt,
  lastEventAt,
  writing = false,
  label,
  onStop,
  onRetry,
}: {
  steps?: ActivityStep[];
  usage?: TokenUsage;
  startedAt: number;
  lastEventAt: number;
  writing?: boolean;
  /** Overrides the current-step label (e.g. a compaction phase). */
  label?: string;
  onStop?: () => void;
  onRetry?: () => void;
}) {
  const now = useNow(true);
  const idle = now - lastEventAt;
  const stalled = idle >= STALL_MS;
  const anyEvent = !!steps?.length || !!usage || writing;
  return (
    <div className="activity" aria-live="polite">
      <StepList steps={steps ?? []} now={now} calls={usage?.calls} />
      <div className={"activity-status" + (stalled ? " stalled" : "")} role="status">
        {stalled ? (
          <>
            <span className="activity-warn">No activity for {Math.floor(idle / 1000)}s</span>
            {onStop && (
              <button type="button" className="chip activity-btn" onClick={onStop}>
                Stop
              </button>
            )}
            {onRetry && (
              <button type="button" className="chip activity-btn" onClick={onRetry}>
                Retry
              </button>
            )}
          </>
        ) : (
          <>
            {!steps?.some((s) => s.status === "running") && <span className="spinner activity-spin" aria-hidden="true" />}
            <span className="activity-now">{label ?? currentLabel(steps, writing, anyEvent)}</span>
          </>
        )}
        <span className="activity-meta">
          {" · "}
          {fmtClock(now - startedAt)}
          {usage && (
            <>
              {" · "}
              <Tokens usage={usage} />
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** The activity of a one-shot job (handoff), folded from its events. */
export interface JobActivity {
  steps: ActivityStep[];
  usage?: TokenUsage;
  startedAt: number;
  lastEventAt: number;
}

export const newJobActivity = (): JobActivity => ({ steps: [], startedAt: Date.now(), lastEventAt: Date.now() });

type ActivityEvent = { type: "step"; step: ActivityStep } | { type: "thinking_delta"; sid: string; text: string } | ({ type: "usage" } & TokenUsage) | { type: string };

/** Folds one job event into its activity (any event counts as activity for the stall warning). */
export function applyJobEvent(a: JobActivity, e: ActivityEvent): JobActivity {
  const at = Date.now();
  if (e.type === "step" && "step" in e) {
    const i = a.steps.findIndex((s) => s.sid === e.step.sid);
    const steps = i < 0 ? [...a.steps, e.step] : a.steps.map((s, j) => (j === i ? { ...s, ...e.step, text: s.text } : s));
    return { ...a, steps, lastEventAt: at };
  }
  if (e.type === "thinking_delta" && "sid" in e) {
    return { ...a, steps: a.steps.map((s) => (s.sid === e.sid ? { ...s, text: (s.text ?? "") + e.text } : s)), lastEventAt: at };
  }
  if (e.type === "usage" && "output" in e) {
    return { ...a, usage: { input: e.input, cacheRead: e.cacheRead, cacheCreate: e.cacheCreate, output: e.output }, lastEventAt: at };
  }
  return { ...a, lastEventAt: at };
}

/** A finished turn: one faint line ("5 steps · 18s · ↑ 12.3k ↓ 640") that expands to its steps. */
export function ActivitySummary({ steps, usage, durationMs, model, retriedFrom }: { steps?: ActivityStep[]; usage?: TokenUsage; durationMs?: number; model?: string; retriedFrom?: string }) {
  const [open, setOpen] = useState(false);
  const n = steps?.length ?? 0;
  if (!n && !usage && !model) return null;
  const parts: string[] = [];
  const name = modelLabel(model);
  if (name) parts.push(retriedFrom ? `${name} (retried, ${modelLabel(retriedFrom) ?? "fast model"} failed)` : name);
  if (n) parts.push(`${n} step${n === 1 ? "" : "s"}`);
  if (durationMs != null) parts.push(fmtDuration(durationMs));
  return (
    <div className="activity-summary">
      <button type="button" className="activity-summary-line" aria-expanded={n ? open : undefined} disabled={!n} onClick={() => setOpen((v) => !v)}>
        {parts.join(" · ")}
        {usage && (
          <>
            {parts.length ? " · " : ""}
            <Tokens usage={usage} />
          </>
        )}
      </button>
      {open && steps && <StepList steps={steps} now={Date.now()} calls={usage?.calls} />}
    </div>
  );
}
