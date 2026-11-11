import { useEffect, useRef, useState } from "react";
import { claudeApi, type ClaudeStatus, type SetupJob } from "../api/claudeIndex";
import { ScrollArea } from "../ui/Scroll";

const POLL_MS = 4000;
const MAX_LOG_LINES = 200;

/** True when the chat can't work yet and the setup screen should show instead. */
export function needsSetup(status: ClaudeStatus | null): boolean {
  return !!status && (!status.installed || status.loggedIn === false);
}

/**
 * Setup screen shown in place of the chat when Claude Code is missing or signed out.
 * Two states: "not installed" (offers `npm install -g`) and "installed but not signed in"
 * (offers `claude auth login`, Claude Code's own browser sign-in). No API key, ever.
 * Re-checks status every few seconds while visible, so a sign-in done in a terminal is
 * picked up without restarting Dreamer.
 */
export function ClaudeSetup({ status, refresh }: { status: ClaudeStatus; refresh: () => Promise<ClaudeStatus> }) {
  const [job, setJob] = useState<SetupJob | null>(status.job ?? null);
  const [log, setLog] = useState<string[]>([]);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const logRef = useRef<HTMLElement | null>(null);
  const jobRef = useRef(job);
  jobRef.current = job;

  // Backend-reported job (e.g. after the panel remounts mid-install).
  useEffect(() => {
    if (status.job) setJob(status.job);
  }, [status.job]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    claudeApi
      .onSetupEvent((e) => {
        if (e.type === "output") {
          setLog((prev) => [...prev, e.line].slice(-MAX_LOG_LINES));
        } else if (e.type === "url") {
          setLoginUrl(e.url);
        } else if (e.type === "done") {
          setJob(null);
          setLoginUrl(null);
          if (!e.ok) setError(e.message);
          void refresh();
        }
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [refresh]);

  // Poll while visible and idle. (During a job the "done" event triggers the re-check.)
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!jobRef.current && document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const start = async (kind: SetupJob) => {
    setError(null);
    setLog([]);
    setLoginUrl(null);
    setJob(kind);
    try {
      await (kind === "install" ? claudeApi.install() : claudeApi.login());
    } catch (e) {
      setJob(null);
      setError(String(e));
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  };

  const installed = status.installed;
  const subtitle = job === "install" ? "Installing Claude Code…" : job === "login" ? "Waiting for sign-in" : installed ? "Not signed in" : "Claude Code not installed";

  return (
    <aside className="glass chat" aria-label="Claude chat" data-wheel-boundary="">
      <header className="chat-head">
        <div className="orb" aria-hidden="true" />
        <div>
          <div className="chat-title">Claude</div>
          <div className="chat-sub">{subtitle}</div>
        </div>
      </header>
      <ScrollArea boundary className="chat-body setup-screen">
        <p>Dreamer talks to Claude through your own Claude Code install and sign-in — no API key needed.</p>

        {job === "login" ? (
          <div className="setup-wait" role="status">
            <div className="setup-wait-row">
              <span className="setup-spinner" aria-hidden="true" />
              <strong>Waiting for browser sign-in…</strong>
            </div>
            <p className="chat-sub">Finish signing in to your Claude account in the browser window that just opened. This panel updates by itself when you're done.</p>
            {loginUrl && (
              <p className="chat-sub">
                Browser didn't open?{" "}
                <button type="button" className="link-button" onClick={() => void claudeApi.openLoginUrl(loginUrl).catch((e) => setError(String(e)))}>
                  Open the sign-in page
                </button>
              </p>
            )}
            <button type="button" className="chip" onClick={() => void claudeApi.cancelSetup()}>
              Cancel
            </button>
          </div>
        ) : job === "install" ? (
          <div className="setup-wait" role="status">
            <div className="setup-wait-row">
              <span className="setup-spinner" aria-hidden="true" />
              <strong>Installing Claude Code…</strong>
            </div>
            <button type="button" className="chip" onClick={() => void claudeApi.cancelSetup()}>
              Cancel
            </button>
          </div>
        ) : installed ? (
          <>
            <p className="setup-found">
              Found Claude Code{status.version ? ` ${status.version}` : ""}
              {status.path && (
                <>
                  {" "}at <code className="setup-path">{status.path}</code>
                </>
              )}
            </p>
            <p>Sign in once with your Claude account. Your browser will open; Dreamer never sees your password or token.</p>
            <button type="button" className="setup-primary" onClick={() => void start("login")}>
              Sign in with Claude
            </button>
            <details className="setup-manual">
              <summary>Prefer a terminal?</summary>
              <p>Run this, then come back — this panel notices automatically:</p>
              <code>claude auth login</code>
            </details>
          </>
        ) : (
          <>
            {status.error && <p className="setup-found">{status.error}</p>}
            <p>Dreamer can install Claude Code for you with npm (needs Node.js).</p>
            <button type="button" className="setup-primary" onClick={() => void start("install")}>
              Install Claude Code
            </button>
            <details className="setup-manual">
              <summary>Prefer a terminal?</summary>
              <ol className="setup-steps">
                <li>
                  Install Claude Code:
                  <code>npm install -g @anthropic-ai/claude-code</code>
                </li>
                <li>
                  Sign in:
                  <code>claude auth login</code>
                </li>
              </ol>
              <p className="chat-sub">This panel checks again every few seconds; no restart needed.</p>
            </details>
          </>
        )}

        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}

        {log.length > 0 && (
          <ScrollArea as="pre" className="setup-log" ref={logRef} aria-label="Setup output">
            {log.join("\n")}
          </ScrollArea>
        )}

        {!job && (
          <button type="button" className="chip setup-recheck" onClick={() => void checkNow()} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
        )}
      </ScrollArea>
    </aside>
  );
}
