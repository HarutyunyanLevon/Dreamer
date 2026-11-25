import { useCallback, useEffect, useRef, useState } from "react";
import { claudeApi } from "../api/claudeIndex";
import type { InstallPhase, LocalRecommendation, LocalStatus } from "../api/claude";
import { Modal } from "../ui/Modal";
import { RESTART_LABEL, useOllamaRestart } from "../state/useOllamaRestart";

const POLL_MS = 4000;
const SIGNIN = "ollama signin";

const gb = (n: number) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
const gib = (n: number) => `${Math.round(n / 2 ** 30)} GB`;

const PHASE_TEXT: Record<InstallPhase, string> = {
  download: "Downloading Ollama…",
  verify: "Checking the installer's signature…",
  run: "Installing Ollama…",
  start: "Starting Ollama…",
};

/** One word for the chat header chip. */
export function localChipLabel(s: LocalStatus | null, on: boolean): string {
  if (!on) return "Local off";
  if (!s) return "Local…";
  return s.ready ? "Local" : "Set up local";
}

/**
 * Setup for the local chat model (Ollama). Ollama missing: "Install Ollama" downloads, verifies
 * and runs the official installer, starts it and goes on to the model. Stopped: Check again starts
 * it. Running without a model: the GPU, the recommended model (picker to override) and Download;
 * a weak GPU gets the cloud model (`ollama signin`) or Claude. Ready: version, model, tools.
 * Re-checks every few seconds while open and idle.
 */
export function LocalSetup({ onClose, onStatus, turnBusy = false }: { onClose: () => void; onStatus?: (s: LocalStatus) => void; /** A reply is streaming: Restart waits. */ turnBusy?: boolean }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [progress, setProgress] = useState<{ status: string; completed: number; total: number } | null>(null);
  const [install, setInstall] = useState<{ phase: InstallPhase; completed: number; total: number } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rec, setRec] = useState<LocalRecommendation | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const rs = useOllamaRestart();
  const busy = pulling || !!install || checking || !!rs.step;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const apply = useCallback(
    (s: LocalStatus) => {
      setStatus(s);
      onStatus?.(s);
      if (s.pulling) setPulling(true);
      if (s.installing) setInstall((i) => i ?? { phase: "download", completed: 0, total: 0 });
    },
    [onStatus],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await claudeApi.localStatus());
    } catch (e) {
      setError(String(e));
    }
  }, [apply]);

  /** Check again: starts a stopped Ollama (up to 20 s), re-reads sign-in. */
  const checkAgain = async () => {
    setError(null);
    setChecking(true);
    try {
      apply(await claudeApi.checkLocal());
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  /** Restart Ollama: stop, start, warm the model; the status line then shows the result. */
  const restartOllama = async () => {
    setError(null);
    const st = await rs.restart();
    if (st) apply(st);
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The recommendation is needed once Ollama runs and the model isn't there yet.
  const needModel = !!status?.running && status.versionOk && !status.ready;
  useEffect(() => {
    if (!needModel || rec) return;
    claudeApi
      .localRecommend()
      .then((r) => {
        setRec(r);
        setPick((p) => p ?? (r.userPicked ? r.current : r.recommended.model));
      })
      .catch(() => {});
  }, [needModel, rec]);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let disposed = false;
    claudeApi
      .onLocalSetupEvent((e) => {
        if (e.type === "install") {
          setError(null);
          setInstall({ phase: e.phase, completed: e.completed, total: e.total });
        } else if (e.type === "progress") {
          setInstall(null);
          setPulling(true);
          setProgress({ status: e.status, completed: e.completed, total: e.total });
        } else if (e.type === "done") {
          setInstall(null);
          setPulling(false);
          setProgress(null);
          if (!e.ok) setError(e.message);
          setRec(null); // settings may have changed (the install picks the model)
          setPick(null);
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
      if (!busyRef.current && document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    }
  };

  const startInstall = () =>
    run(async () => {
      setInstall({ phase: "download", completed: 0, total: 0 });
      try {
        await claudeApi.installOllama();
      } catch (e) {
        setInstall(null);
        throw e;
      }
    });

  const download = (model: string) =>
    run(async () => {
      setPulling(true);
      try {
        apply(await claudeApi.useLocalModel(model, true));
      } catch (e) {
        setPulling(false);
        throw e;
      }
    });

  const useCloud = (model: string) => run(async () => apply(await claudeApi.useLocalModel(model, false)));

  const locate = () =>
    run(async () => {
      setChecking(true);
      try {
        const s = await claudeApi.locateOllama();
        if (s) apply(s);
      } finally {
        setChecking(false);
      }
    });

  const copySignin = async () => {
    try {
      await navigator.clipboard.writeText(SIGNIN);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError(`Couldn't copy. Type ${SIGNIN} in a terminal.`);
    }
  };

  const s = status;
  const pct = progress && progress.total > 0 ? Math.min(100, (progress.completed / progress.total) * 100) : null;
  const ipct = install && install.phase === "download" && install.total > 0 ? Math.min(100, (install.completed / install.total) * 100) : null;
  const chosen = rec?.choices.find((c) => c.model === pick) ?? rec?.recommended ?? null;

  const manualLinks = (
    <p className="chat-sub">
      <button type="button" className="link-button" onClick={() => void run(() => claudeApi.openOllamaInstaller())}>
        Get Ollama for Windows
      </button>{" "}
      (install it yourself) ·{" "}
      <button type="button" className="link-button" onClick={() => void locate()}>
        Locate ollama.exe…
      </button>
    </p>
  );

  const signinBlock = (
    <>
      <p>
        Run <code className="setup-path">{SIGNIN}</code> in a terminal (it opens Ollama's sign-in page; Dreamer never sees your account), then press Check again.
      </p>
      <div className="editor-actions">
        <button type="button" className="chip" onClick={() => void copySignin()}>
          {copied ? "Copied" : "Copy the command"}
        </button>
      </div>
    </>
  );

  const gpuLine = rec && (
    <p className="setup-found">
      {rec.gpu ? (
        <>
          GPU: {rec.gpu.name}
          {rec.gpu.vram ? ` · ${gib(rec.gpu.vram)}` : " · memory unknown"}
        </>
      ) : (
        "No dedicated GPU found."
      )}{" "}
      Recommended: <code className="setup-path">{rec.recommended.model}</code>
      {rec.recommended.cloud ? " (runs on Ollama's servers)" : ` (${gb(rec.recommended.size)} download)`}.
    </p>
  );

  const modelPicker = rec && (
    <>
      {gpuLine}
      <label className="local-pick">
        <span>Model</span>
        <select className="artifact-select" value={pick ?? ""} onChange={(e) => setPick(e.target.value)}>
          {rec.choices.map((c) => (
            <option key={c.model} value={c.model}>
              {c.label} · {c.cloud ? "cloud, no download" : `${gb(c.size)}, for ${c.minVramGb}+ GB`}
              {c.model === rec.recommended.model ? " · recommended" : ""}
            </option>
          ))}
          {!rec.choices.some((c) => c.model === rec.current) && <option value={rec.current}>{rec.current} (from Settings)</option>}
        </select>
      </label>
      {chosen?.cloud ? (
        <>
          <p>
            {rec.recommended.cloud ? "This PC's GPU is too small to run a chat model well. " : ""}
            <code className="setup-path">{chosen.model}</code> runs on Ollama's servers through Ollama (free with an Ollama account, with usage limits), so chat stays free of Claude usage.
          </p>
          <div className="editor-actions">
            <button type="button" className="setup-primary" onClick={() => void useCloud(chosen.model)}>
              Use {chosen.model}
            </button>
            <button type="button" className="chip" onClick={() => void run(async () => apply(await claudeApi.declineLocalCloud()))}>
              No thanks, use Claude
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="setup-primary" disabled={!pick} onClick={() => pick && void download(pick)}>
          Download {pick}
          {chosen && !chosen.cloud ? ` (${gb(chosen.size)})` : ""}
        </button>
      )}
    </>
  );

  return (
    <Modal onClose={onClose} label="Local model" size="sm">
      <h3 className="dialog-title">Local model</h3>
      <div className="setup-screen local-setup">
        <p>Everyday chat runs on a model on this computer through Ollama, so it costs no Claude usage. Think harder, web access and Retry with Claude still use Claude.</p>
        {s?.hostNote && (
          <p className="setup-found" role="note">
            {s.hostNote}
          </p>
        )}
        {!s ? (
          <p className="chat-sub">Checking Ollama…</p>
        ) : install ? (
          <div className="setup-wait" role="status">
            <div className="setup-wait-row">
              <span className="setup-spinner" aria-hidden="true" />
              <strong>{PHASE_TEXT[install.phase]}</strong>
            </div>
            {install.phase === "download" ? (
              <>
                <div className="local-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ipct ?? undefined} aria-label="Installer download">
                  <span style={{ width: `${ipct ?? 0}%` }} />
                </div>
                <p className="chat-sub">{install.total > 0 ? `${gb(install.completed)} of ${gb(install.total)}` : "connecting"} · Ollama's official installer, from GitHub</p>
                <button type="button" className="chip" onClick={() => void claudeApi.cancelInstallOllama()}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <div className="local-progress indeterminate" role="progressbar" aria-label={PHASE_TEXT[install.phase]}>
                  <span />
                </div>
                <p className="chat-sub">{install.phase === "run" ? "No windows or prompts: it installs for this Windows user only." : "Then the model for your GPU downloads."}</p>
              </>
            )}
          </div>
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
        ) : checking ? (
          <div className="setup-wait" role="status">
            <div className="setup-wait-row">
              <span className="setup-spinner" aria-hidden="true" />
              <strong>{s.installed && !s.running ? "Starting Ollama (up to 20 s)…" : "Checking…"}</strong>
            </div>
          </div>
        ) : s.foreign ? (
          <p className="setup-found">{s.error}</p>
        ) : !s.running ? (
          <>
            {s.error && <p className="setup-found">{s.error}</p>}
            {s.installed ? (
              <>
                {s.exe && <p className="chat-sub">Found: <code className="setup-path">{s.exe}</code></p>}
                <button type="button" className="setup-primary" onClick={() => void checkAgain()}>
                  Start Ollama
                </button>
              </>
            ) : (
              <>
                <p>Dreamer downloads Ollama's official Windows installer (about 1.9 GB), checks its signature, installs it for your Windows user (no admin prompt), and then sets up a model for your GPU.</p>
                <button type="button" className="setup-primary" onClick={() => void startInstall()}>
                  Install Ollama
                </button>
              </>
            )}
            {manualLinks}
          </>
        ) : !s.versionOk ? (
          <>
            <p className="setup-found">{s.error}</p>
            <button type="button" className="setup-primary" onClick={() => void startInstall()}>
              Update Ollama
            </button>
            {manualLinks}
          </>
        ) : s.needsSignin ? (
          <>
            <p className="setup-found">Ollama {s.version} is running. {s.model} runs on Ollama's servers and needs an Ollama account.</p>
            {signinBlock}
            {rec && (
              <button type="button" className="link-button" onClick={() => void run(async () => apply(await claudeApi.declineLocalCloud()))}>
                No thanks, use Claude
              </button>
            )}
          </>
        ) : !s.pulled ? (
          <>
            <p className="setup-found">Ollama {s.version} is running.</p>
            {s.declined && <p className="setup-found">{s.error}</p>}
            {rec ? modelPicker : <p className="chat-sub">Looking at the GPU…</p>}
          </>
        ) : !s.ready ? (
          <p className="setup-found">{s.error}</p>
        ) : (
          <>
            <p className="setup-found">
              Ready: Ollama {s.version}, <code className="setup-path">{s.model}</code>
              {s.cloud ? " (cloud)" : ""} · tools{s.vision ? " · images" : " · no images (image turns use Claude)"}
              {s.cloud ? "" : " · 64k context"}
            </p>
            {!s.cloud && <p className="chat-sub">The first reply after a few idle minutes takes a few seconds while Ollama loads the model.</p>}
          </>
        )}
        {(error || rs.error) && (
          <p className="setup-error" role="alert">
            {error ?? rs.error}
          </p>
        )}
        <p className="chat-sub">Change the model or turn local chat off under Settings.</p>
        <div className="editor-actions">
          {!busy && (
            <button type="button" className="chip" onClick={() => void checkAgain()}>
              Check again
            </button>
          )}
          {(!busy || rs.step) && status?.installed && !status.foreign && !status.installing && (
            <button type="button" className="chip" disabled={!!rs.step || turnBusy} title={turnBusy ? "Wait for the reply to finish" : "Stop Ollama, start it again and load the model"} onClick={() => void restartOllama()}>
              {rs.step ? RESTART_LABEL[rs.step] : "Restart Ollama"}
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
