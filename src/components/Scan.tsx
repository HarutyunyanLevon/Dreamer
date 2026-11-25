import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";
import { openImport } from "./Import";

let opener: (() => void) | null = null;
/** Opens the "Scan repo for built features" dialog (project menu, Design view). */
export const openScan = () => opener?.();

interface Running {
  job: string;
  note: string;
  step: string;
  bundle: string | null;
  error: string | null;
}

/** Scope, size and model for a scan; then a small glass panel with progress and Cancel; the bundle goes to the import preview. */
export function ScanHost({ ws }: { ws: Workspace }) {
  const [dialog, setDialog] = useState(false);
  const [run, setRun] = useState<Running | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [subfolder, setSubfolder] = useState(false);
  const [max, setMax] = useState("40");
  const [model, setModel] = useState("");
  const job = useRef<string | null>(null);
  const bundle = useRef<string | null>(null);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const repo = ws.data?.meta.handoff_target ?? null;

  useEffect(() => {
    opener = () => {
      if (!wsRef.current.active || !wsRef.current.data?.meta.handoff_target) {
        wsRef.current.setError("Link a repo first (Link repo… in the sidebar).");
        return;
      }
      setFolder(null);
      setSubfolder(false);
      api.getSettings().then((s) => setModel(s.model_export)).catch(() => setModel(""));
      setDialog(true);
    };
    return () => {
      opener = null;
    };
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    api
      .onScanEvent((e) => {
        if (e.job !== job.current) return;
        if (e.type === "progress") setRun((r) => r && { ...r, note: e.note });
        else if (e.type === "step") setRun((r) => r && { ...r, step: e.label });
        else if (e.type === "bundle") bundle.current = e.bundle;
        else if (e.type === "done") {
          const b = bundle.current;
          job.current = null;
          setRun(null);
          if (b) openImport(b);
        } else if (e.type === "error") {
          job.current = null;
          setRun((r) => r && { ...r, error: e.message });
        }
      })
      .then((u) => (gone ? u() : (un = u)))
      .catch(() => {});
    return () => {
      gone = true;
      un?.();
    };
  }, []);

  const begin = async () => {
    if (!ws.active) return;
    setDialog(false);
    bundle.current = null;
    const n = Math.max(1, Math.floor(Number(max)) || 40);
    try {
      const id = await api.scanStart(ws.active, subfolder ? folder : null, n, model.trim() || null);
      job.current = id;
      setRun({ job: id, note: "Starting…", step: "", bundle: null, error: null });
    } catch (e) {
      ws.setError(String(e));
    }
  };

  const cancel = () => {
    job.current = null;
    setRun(null);
    void api.scanCancel().catch(() => {});
  };

  return (
    <>
      {dialog && (
        <Modal onClose={() => setDialog(false)} label="Scan repo for built features" size="sm">
          <h3 className="dialog-title">Scan repo for built features</h3>
          <p className="chat-sub">Claude reads the code (it can only read) and proposes one Built card per feature. You review them before anything is added.</p>
          <code className="dialog-path">{repo}</code>
          <div className="model-form">
            <label className="check-row">
              <input type="radio" name="scan-scope" checked={!subfolder} onChange={() => setSubfolder(false)} />
              Whole repo
            </label>
            <label className="check-row">
              <input type="radio" name="scan-scope" checked={subfolder} onChange={() => setSubfolder(true)} />
              A subfolder
            </label>
            {subfolder && (
              <div className="editor-actions">
                <code className="dialog-path">{folder ?? "No folder picked"}</code>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void api.pickFolder("Folder to scan").then((p) => p && setFolder(p), (e) => ws.setError(String(e)))}
                >
                  Pick…
                </button>
              </div>
            )}
            <label>
              Most cards
              <input className="name-input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
            </label>
            <label>
              Model
              <input className="name-input" value={model} placeholder="opus" onChange={(e) => setModel(e.target.value)} />
            </label>
          </div>
          <div className="editor-actions">
            <div className="side-spacer" />
            <button type="button" className="btn" onClick={() => setDialog(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={subfolder && !folder} onClick={() => void begin()}>Scan</button>
          </div>
        </Modal>
      )}
      {run && (
        <div className="toast glass" role="status" aria-live="polite">
          <span>
            {run.error ? run.error : <>Scanning the repo… {run.note}{run.step && <span className="chat-sub"> · {run.step}</span>}</>}
          </span>
          <button type="button" className="btn" onClick={cancel}>{run.error ? "Close" : "Cancel"}</button>
        </div>
      )}
    </>
  );
}
