import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ImportOffer, type ImportPlan, type ImportResult, type ImportTarget } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";

/** First non-blank line (after an optional fence) is `---` and the header has dreamer_bundle. */
export function looksLikeBundle(text: string): boolean {
  const t = text.replace(/^﻿/, "").trimStart().replace(/^```[^\n]*\r?\n/, "");
  return /^---\r?\n/.test(t) && /^dreamer_bundle\s*:/m.test(t.slice(0, 3000));
}

type Opener = (text: string, o?: { at?: [number, number]; archive?: string }) => void;
let opener: Opener | null = null;
/** Opens the import preview (paste, drop, menu, drop folder). `at`: world point for the first card. */
export const openImport: Opener = (text, o) => opener?.(text, o);

let hotkeyOpener: (() => void) | null = null;
/** Opens the global hotkeys dialog. */
export const openHotkeys = () => hotkeyOpener?.();

/** A file picker for "Import bundle…" (menus call this). */
export function pickBundle(at?: [number, number]) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.dreamer.md,text/markdown,text/plain";
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) openImport(await f.text(), { at });
  };
  input.click();
}

const STAGE_WORD: Record<string, string> = { mist: "Mist", reverie: "Reverie", lucid: "Lucid", dream: "Dream", built: "Built" };
const BADGE: Record<string, string> = { new: "New", update: "Update", replace: "Replace ghost" };

interface Open {
  text: string;
  at?: [number, number];
  archive?: string;
}
interface Last {
  res: ImportResult;
  title: string;
  bundle: string;
}

export function ImportHost({ ws }: { ws: Workspace }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [last, setLast] = useState<Last | null>(null);
  const [hidden, setHidden] = useState(false);
  const [offers, setOffers] = useState<ImportOffer[]>([]);
  const [hotkeys, setHotkeys] = useState(false);
  const snoozed = useRef<Set<string>>(new Set());
  const wsRef = useRef(ws);
  wsRef.current = ws;

  useEffect(() => {
    opener = (text, o) => setOpen({ text, ...o });
    hotkeyOpener = () => setHotkeys(true);
    return () => {
      opener = null;
      hotkeyOpener = null;
    };
  }, []);

  // Files waiting in the drop folders: now, when the window comes back, and every so often.
  useEffect(() => {
    if (api.kind !== "tauri") return;
    const scan = () => void api.scanImports().then(setOffers).catch(() => {});
    scan();
    const t = setInterval(scan, 15000);
    window.addEventListener("focus", scan);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", scan);
    };
  }, []);
  const offer = offers.find((o) => !snoozed.current.has(o.path));
  const settleOffer = async (o: ImportOffer, archive: boolean) => {
    snoozed.current.add(o.path);
    if (archive) await api.archiveImport(o.path).catch((e) => ws.setError(String(e)));
    setOffers(await api.scanImports().catch(() => []));
  };

  const done = useCallback(
    async (res: ImportResult, plan: ImportPlan, archive?: string) => {
      setOpen(null);
      if (archive) await api.archiveImport(archive).catch(() => {});
      const w = wsRef.current;
      if (res.project !== w.active) await w.select(res.project);
      if (res.folder && w.folder !== res.folder) w.openFolder(res.folder);
      await w.refresh();
      setLast({ res, title: plan.header.title, bundle: plan.header.bundle_id });
      setHidden(false);
    },
    [],
  );

  // The pill stays while ghosts from this import remain.
  const left = last ? (ws.data?.cards ?? []).filter((c) => c.ghost && last.res.created.includes(c.id)) : [];
  const props = last ? last.res.proposals.filter((id) => ws.data?.proposals?.[id]) : [];
  const pending = left.length + props.length;
  const keepAll = async () => {
    for (const c of left) await ws.keepGhostCard(c.id);
    if (props.length) ws.toast(`${props.length} update${props.length === 1 ? "" : "s"} to review on the cards.`);
  };
  const dismissAll = async () => {
    if (!last) return;
    await ws.deleteCards(left.map((c) => c.id));
    for (const id of props) await api.dismissProposal(last.res.project, id).catch(() => {});
    await ws.refresh();
  };
  const undo = async () => {
    if (!last) return;
    await api.undoBundle(last.res).catch((e) => ws.setError(String(e)));
    setLast(null);
    await ws.refresh();
  };
  const n = last ? last.res.created.length + last.res.proposals.length : 0;

  return (
    <>
      {hotkeys && <HotkeysDialog onClose={() => setHotkeys(false)} />}
      {open && <ImportDialog ws={ws} open={open} onClose={() => setOpen(null)} onDone={done} />}
      {offer && !open && (
        <div className="toast import-offer" role="status">
          <span>
            Import {offer.count} card{offer.count === 1 ? "" : "s"} from {offer.source}?
          </span>
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              const text = await api.readImport(offer.path).catch((e) => (ws.setError(String(e)), null));
              if (text) {
                snoozed.current.add(offer.path);
                setOpen({ text, archive: offer.path });
              }
            }}
          >
            Preview
          </button>
          <button type="button" className="btn" onClick={() => void settleOffer(offer, false)}>Later</button>
          <button type="button" className="btn" title="Move it to the imported folder" onClick={() => void settleOffer(offer, true)}>Dismiss</button>
        </div>
      )}
      {last && !hidden && pending > 0 && !open && (
        <div className="import-pill glass" role="status">
          <span>
            {pending === n ? `${n} card${n === 1 ? "" : "s"} imported as suggestions` : `${pending} suggestion${pending === 1 ? "" : "s"} left from “${last.title}”`}
          </span>
          <button type="button" className="btn primary" onClick={() => void keepAll()}>Keep all</button>
          <button type="button" className="btn" onClick={() => void dismissAll()}>Dismiss all</button>
          <button type="button" className="btn" onClick={() => void undo()}>Undo</button>
          <button type="button" className="icon-btn" aria-label="Hide" onClick={() => setHidden(true)}>×</button>
        </div>
      )}
    </>
  );
}

function ImportDialog({ ws, open, onClose, onDone }: { ws: Workspace; open: Open; onClose: () => void; onDone: (r: ImportResult, p: ImportPlan, archive?: string) => Promise<void> }) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [pick, setPick] = useState<ImportTarget>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showWarn, setShowWarn] = useState(false);
  const target = useCallback((p: ImportTarget): ImportTarget => ({ ...p, open_project: ws.active ?? undefined, ...(open.at ? { at: open.at } : {}) }), [ws.active, open.at]);

  useEffect(() => {
    let live = true;
    api.parseBundle(open.text, target(pick)).then(
      (p) => live && (setPlan(p), setErr(null)),
      (e) => live && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [open.text, pick, target]);

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const res = await api.applyBundle(open.text, target({ project: plan.project, version: plan.version ?? undefined, frame: plan.frame ?? "" }));
      await onDone(res, plan, open.archive);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const proj = plan?.projects.find((p) => p.slug === plan.project);
  return (
    <Modal onClose={onClose} label="Import cards" size="md" className="import-modal">
      <div className="modal-head">
        <h3>{plan?.header.title ?? "Import cards"}</h3>
        {plan && <span className="chip">{plan.header.source}</span>}
      </div>
      {err && <p className="capture-error" role="alert">{err}</p>}
      {plan && (
        <>
          {plan.unresolved.length > 0 && (
            <p className="helper">The bundle names a {plan.unresolved.join(" and ")} that doesn’t exist here. Pick where it goes.</p>
          )}
          <div className="import-pickers">
            <label>
              Project
              <select value={plan.project} onChange={(e) => setPick({ project: e.target.value, frame: "" })}>
                {plan.projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
              </select>
            </label>
            {proj && proj.versions.length > 0 && (
              <label>
                Version
                <select value={plan.version ?? ""} onChange={(e) => setPick({ project: plan.project, version: e.target.value, frame: "" })}>
                  {proj.versions.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
                </select>
              </label>
            )}
            <label>
              Default frame
              <input list="import-frames" value={plan.frame ?? ""} placeholder="(none)" onChange={(e) => setPick({ project: plan.project, version: plan.version ?? undefined, frame: e.target.value })} />
              <datalist id="import-frames">{plan.frames.map((f) => <option key={f} value={f} />)}</datalist>
            </label>
          </div>
          <ul className="import-list">
            {plan.cards.map((c) => (
              <li key={c.ref}>
                <span className={`import-badge ${c.action}`}>{BADGE[c.action]}</span>
                <span className="import-title">{c.title}</span>
                <span className="helper">{STAGE_WORD[c.stage] ?? c.stage}{c.frame ? ` · ${c.frame}` : ""}{c.has_build ? " · build info" : ""}</span>
              </li>
            ))}
          </ul>
          {plan.warnings.length > 0 && (
            <div className="import-warn">
              <button type="button" className="chip" onClick={() => setShowWarn(!showWarn)}>{plan.warnings.length} warning{plan.warnings.length === 1 ? "" : "s"} {showWarn ? "▾" : "▸"}</button>
              {showWarn && <ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
            </div>
          )}
        </>
      )}
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!plan || busy || plan.cards.length === 0} onClick={() => void run()}>
          Import {plan ? plan.cards.length : ""} card{plan?.cards.length === 1 ? "" : "s"}
        </button>
      </div>
    </Modal>
  );
}

/** Settings for the two global shortcuts, with the registration error when one failed. */
export function HotkeysDialog({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<[string, string]>(["", ""]);
  const [errs, setErrs] = useState<[string | null, string | null]>([null, null]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api.getSettings().then((s) => setKeys([s.hotkey, s.clipboard_hotkey]));
    void api.hotkeyStatus().then(setErrs);
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings({ hotkey: keys[0], clipboard_hotkey: keys[1] });
      setErrs(await api.hotkeyStatus());
    } catch (e) {
      setErrs([String(e), null]);
    } finally {
      setSaving(false);
    }
  };
  const row = (i: 0 | 1, label: string) => (
    <label className="hotkey-row">
      {label}
      <input value={keys[i]} aria-invalid={errs[i] ? true : undefined} onChange={(e) => setKeys(i === 0 ? [e.target.value, keys[1]] : [keys[0], e.target.value])} placeholder="Ctrl+Alt+Shift+V" />
      {errs[i] && <span className="capture-error" role="alert">Couldn’t register this shortcut: {errs[i]}</span>}
    </label>
  );
  return (
    <Modal onClose={onClose} label="Global hotkeys" size="sm">
      <div className="modal-head"><h3>Global hotkeys</h3></div>
      {row(0, "Quick capture")}
      {row(1, "Clipboard to Inbox")}
      <p className="helper">Write them like Ctrl+Alt+Shift+V. They work while Dreamer sits in the tray.</p>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}
