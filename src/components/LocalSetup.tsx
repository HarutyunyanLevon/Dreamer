import { useCallback, useEffect, useState } from "react";
import { claudeApi } from "../api/claudeIndex";
import type { LocalStatus } from "../api/claude";
import { Modal } from "../ui/Modal";

const POLL_MS = 4000;

const gb = (n: number) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;

/** One word for the chat header chip. */
export function localChipLabel(s: LocalStatus | null, on: boolean): string {
  if (!on) return "Local off";
  if (!s) return "Local…";
  return s.ready ? "Local" : "Set up local";
}

/**
 * Setup for the local chat model (Ollama), next to the Claude Code setup. Three states: Ollama
 * missing or stopped (link to the Windows installer), model missing (download with a progress bar),
 * ready (version, model, tools/vision). Re-checks every few seconds while open and idle, so starting
 * Ollama or installing it is picked up without a restart.
 */
export function LocalSetup({ onClose, onStatus }: { onClose: () => void; onStatus?: (s: LocalStatus) => void }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [progress, setProgress] = useState<{ status: string; completed: number; total: number } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await claudeApi.localStatus();
      setStatus(s);
      onStatus?.(s);
      if (s.pulling) setPulling(true);
    } catch (e) {
      setError(String(e));
    }
  }, [onStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    claudeApi
      .onLocalSetupEvent((e) => {
        if (e.type === "progress") {
          setPulling(true);
          setProgress({ status: e.status, completed: e.completed, total: e.total });
        } else {
          setPulling(false);
          setProgress(null);
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

  useEffect(() => {
    const t = window.setInterval(() => {
      if (!pulling && document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh, pulling]);

  const pull = async () => {
    setError(null);
    setPulling(true);
    try {
      await claudeApi.pullLocal();
    } catch (e) {
      setPulling(false);
      setError(String(e));
    }
  };

  const s = status;
  const pct = progress && progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : null;

  return (
    <Modal onClose={onClose} label="Local model" size="sm">
      <h3 className="dialog-title">Local model</h3>
      <div className="setup-screen local-setup">
        <p>Everyday chat runs on a model on this computer through Ollama, so it costs no Claude usage. Think harder, web access and Retry with Claude still use Claude.</p>
        {!s ? (
          <p className="chat-sub">Checking Ollama…</p>
        ) : pulling ? (
          <div className="setup-wait" role="status">
            <div className="setup-wait-row">
              <span className="setup-spinner" aria-hidden="true" />
              <strong>Downloading {s.model}…</strong>
            </div>
            <div className="local-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} aria-label="Download progress">
              <span style={{ width: `${pct ?? 0}%` }} />
            </div>
            <p className="chat-sub">
              {progress?.status ?? "starting"}
              {progress && progress.total > 0 && ` · ${gb(progress.completed)} of ${gb(progress.total)}`}
            </p>
            <button type="button" className="chip" onClick={() => void claudeApi.cancelPullLocal()}>
              Cancel
            </button>
          </div>
        ) : !s.running ? (
          <>
            {s.error && <p className="setup-found">{s.error}</p>}
            {s.installed ? (
              <p>Start Ollama (Start menu › Ollama). It then runs in the tray; this panel notices by itself.</p>
            ) : (
              <>
                <p>Install Ollama for Windows (0.14 or newer), then come back.</p>
                <button type="button" className="setup-primary" onClick={() => void claudeApi.openOllamaInstaller().catch((e) => setError(String(e)))}>
                  Get Ollama for Windows
                </button>
              </>
            )}
          </>
        ) : !s.versionOk ? (
          <>
            <p className="setup-found">{s.error}</p>
            <button type="button" className="setup-primary" onClick={() => void claudeApi.openOllamaInstaller().catch((e) => setError(String(e)))}>
              Update Ollama
            </button>
          </>
        ) : !s.pulled ? (
          <>
            <p className="setup-found">Ollama {s.version} is running.</p>
            <p>
              Download <code className="setup-path">{s.model}</code> (about 22 GB for the default model; it needs a GPU with ~24 GB of memory to run fast, or it falls back to the CPU and is slow).
            </p>
            <button type="button" className="setup-primary" onClick={() => void pull()}>
              Download the model
            </button>
          </>
        ) : !s.ready ? (
          <p className="setup-found">{s.error}</p>
        ) : (
          <>
            <p className="setup-found">
              Ready: Ollama {s.version}, <code className="setup-path">{s.model}</code> · tools{s.vision ? " · images" : " · no images (image turns use Claude)"} · 64k context
            </p>
            <p className="chat-sub">The first reply after a few idle minutes takes a few seconds while Ollama loads the model.</p>
          </>
        )}
        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}
        <p className="chat-sub">Change the model or turn local chat off under Settings.</p>
        <div className="editor-actions">
          {!pulling && (
            <button type="button" className="chip" onClick={() => void refresh()}>
              Check again
            </button>
          )}
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
