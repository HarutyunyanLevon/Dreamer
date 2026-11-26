import { useMemo, useState } from "react";
import { api, type ClipAttachment, type ProjectData } from "../../api";
import { type Workspace } from "../../state/workspace";
import { Layer } from "../../ui/Layer";
import { Modal } from "../../ui/Modal";
import { ScrollArea } from "../../ui/Scroll";
import { IconSparkle } from "../Icons";
import { type MenuEnv } from "./menus/canvasMenu";
import { asUrl } from "../../util/media";
import { DuskStrip } from "../DuskGlass";

export function Warnings({ data }: { data: ProjectData }) {
  const n = data.warnings.length;
  return (
    <div className="pill warn-pill" role="status" title={data.warnings.join("\n")}>
      {n === 1 ? "1 card file couldn't be read" : `${n} card files couldn't be read`}
    </div>
  );
}
export function SuggestionsPill({ data, ws }: { data: ProjectData; ws: Workspace }) {
  const [pop, setPop] = useState<{ left: number; top: number } | null>(null);
  const [confirm, setConfirm] = useState<"keep" | "dismiss" | null>(null);
  const items = useMemo(() => {
    const props = data.proposals ?? {};
    return data.cards
      .filter((c) => c.ghost || props[c.id])
      .map((c) => ({ id: c.id, title: c.title || "Untitled", what: c.ghost ? (c.merged_from?.length ? "New card (merge)" : "New card") : "Changes" }));
  }, [data]);
  const n = items.length;
  if (!n) return null;
  const close = () => {
    setPop(null);
    setConfirm(null);
  };
  const settle = (what: "keep" | "dismiss") => {
    if (n > 5 && confirm !== what) return setConfirm(what);
    close();
    void (what === "keep" ? ws.keepAllSuggestions() : ws.dismissAllSuggestions());
  };
  return (
    <>
      <DuskStrip seed={data.slug} className="suggest-pill">
        <button
          type="button"
          className="dusk-pill"
          aria-expanded={!!pop}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setPop({ left: r.left, top: r.bottom + 6 });
          }}
        >
          <IconSparkle /> {n} suggestion{n === 1 ? "" : "s"}
        </button>
      </DuskStrip>
      {pop && (
        <Layer onClose={close}>
          <div className="suggest-pop glass" style={{ left: pop.left, top: pop.top }} role="dialog" aria-label="Claude suggestions">
            <ScrollArea className="suggest-list">
              {items.map((it) => (
                <button key={it.id} type="button" className="theme-picker-row suggest-row" onClick={() => { close(); void ws.focusCard(it.id); }}>
                  <span className="suggest-title">{it.title}</span>
                  <span className="suggest-what">{it.what}</span>
                </button>
              ))}
            </ScrollArea>
            {confirm && <p className="suggest-confirm">{confirm === "keep" ? `Keep all ${n} suggestions?` : `Dismiss all ${n} suggestions?`} Undo brings them back.</p>}
            <div className="suggest-actions">
              <button type="button" className="btn" onClick={() => settle("dismiss")}>{confirm === "dismiss" ? "Yes, dismiss all" : "Dismiss all"}</button>
              <button type="button" className="btn primary" onClick={() => settle("keep")}>{confirm === "keep" ? "Yes, keep all" : "Keep all"}</button>
            </div>
          </div>
        </Layer>
      )}
    </>
  );
}

/** A one-line text prompt for menu actions (tag, link label, caption). Enter saves, Esc cancels. */
export function AskText({ title, label, initial, placeholder, submit, onClose }: Parameters<MenuEnv["askText"]>[0] & { onClose: () => void }) {
  const [value, setValue] = useState(initial ?? "");
  return (
    <Modal onClose={onClose} label={title} size="sm" className="clip-prompt">
      <h3>{title}</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          submit(value);
        }}
      >
        <input className="name-input" autoFocus aria-label={label} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        <div className="editor-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

export function WebClipPrompt({ slug, onClose, onCreate }: { slug: string | null; onClose: () => void; onCreate: (clip: ClipAttachment, title: string) => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const target = asUrl(url) ?? asUrl(`https://${url.trim()}`);
  const add = async () => {
    if (!target || !slug) return;
    setBusy(true);
    const clip = await api.fetchClip(slug, target).catch((): ClipAttachment => ({ id: "", type: "clip", url: target }));
    onCreate(clip, name.trim());
    onClose();
  };
  return (
    <Modal onClose={onClose} label="Web clip" size="sm" className="clip-prompt">
        <h3>Web clip</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="name-input" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" disabled={busy} />
          <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Title (optional)" disabled={busy} />
          <div className="editor-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!target || busy}>
              {busy ? <><span className="spinner" aria-hidden="true" /> Fetching…</> : "Add"}
            </button>
          </div>
        </form>
    </Modal>
  );
}
