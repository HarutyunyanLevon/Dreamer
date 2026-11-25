import { useMemo, useState } from "react";
import type { Card, Folder, ProjectData } from "../api";
import { cardVersions, folderName, nextVersionTitle, versionOf, versionsOf, type Workspace } from "../state/useWorkspace";
import { STAGE_LABEL } from "../theme/types";
import { Layer } from "../ui/Layer";
import { Modal } from "../ui/Modal";
import { ScrollArea } from "../ui/Scroll";
import { diffLines } from "../util/diff";
import { IconClose } from "./Icons";

/** The open version: the one the open folder is in, else the project's last one. */
export function openVersion(d: ProjectData, folder: string | null): Folder | undefined {
  const vs = versionsOf(d.folders);
  return versionOf(d.folders, folder) ?? vs.find((v) => v.id === d.meta.last_version) ?? vs[vs.length - 1];
}

/** Title-pill "· v2 ▾" menu: switch version, New version from…, Compare versions…, Rename version. */
export function VersionMenu({ ws, at, onClose }: { ws: Workspace; at: { left: number; top: number }; onClose: () => void }) {
  const d = ws.data;
  if (!d) return null;
  const vs = versionsOf(d.folders);
  const open = openVersion(d, ws.folder);
  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Layer onClose={onClose}>
      <ScrollArea boundary className="theme-picker-pop glass" style={{ left: at.left, top: at.top }} role="menu" aria-label="Project version">
        {[...vs].reverse().map((v) => (
          <button key={v.id} type="button" role="menuitemradio" aria-checked={v.id === open?.id} className={"theme-picker-row" + (v.id === open?.id ? " on" : "")} onClick={go(() => ws.openFolder(v.id))}>
            <span className="version-badge" aria-hidden="true">v</span> {folderName(v)}
          </button>
        ))}
        <div className="menu-sep" role="separator" />
        {open && (
          <button type="button" role="menuitem" className="theme-picker-row" onClick={go(() => ws.setVersionDialog({ kind: "new", from: open.id }))}>
            New version from {folderName(open)}…
          </button>
        )}
        <button type="button" role="menuitem" className="theme-picker-row" aria-disabled={vs.length < 2} onClick={go(() => vs.length > 1 && ws.setVersionDialog({ kind: "compare" }))}>
          Compare versions…
        </button>
        {open && (
          <button type="button" role="menuitem" className="theme-picker-row" onClick={go(() => ws.setVersionDialog({ kind: "rename", id: open.id }))}>
            Rename version
          </button>
        )}
      </ScrollArea>
    </Layer>
  );
}

/** Renders whichever version dialog is open, plus the one-time migration question. */
export function VersionsHost({ ws }: { ws: Workspace }) {
  const d = ws.data;
  const [skipped, setSkipped] = useState<string | null>(null);
  const dlg = ws.versionDialog;
  const close = () => ws.setVersionDialog(null);
  return (
    <>
      {d?.version_migration && skipped !== d.slug && <MigrateDialog ws={ws} data={d} onClose={() => setSkipped(d.slug)} />}
      {d && dlg?.kind === "new" && <NewVersionDialog ws={ws} data={d} from={dlg.from} onClose={close} />}
      {d && dlg?.kind === "rename" && <RenameVersionDialog ws={ws} data={d} id={dlg.id} onClose={close} />}
      {d && dlg?.kind === "compare" && <CompareVersions ws={ws} data={d} a={dlg.a} b={dlg.b} card={dlg.card} onClose={close} />}
    </>
  );
}

function MigrateDialog({ ws, data, onClose }: { ws: Workspace; data: ProjectData; onClose: () => void }) {
  const list = data.version_migration!.folders;
  const [checked, setChecked] = useState(() => new Set(list.filter((f) => f.suggested).map((f) => f.id)));
  const first = list.find((f) => checked.has(f.id));
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose} label="Treat these folders as versions?" size="md">
      <h3 className="dialog-title">Treat these folders as versions?</h3>
      <p className="chat-sub">Projects now have versions (v1, v2…), each a full copy of the design. Tick the folders that already are versions. A backup of the project is made first.</p>
      <div className="handoff-frames" role="group" aria-label="Top-level folders">
        {list.map((f) => (
          <label key={f.id} className="handoff-check">
            <input
              type="checkbox"
              checked={checked.has(f.id)}
              onChange={(e) =>
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(f.id);
                  else next.delete(f.id);
                  return next;
                })
              }
            />
            {f.title}
          </label>
        ))}
      </div>
      <p className="chat-sub" aria-live="polite">
        {first ? `Everything else at the top (cards, frames, unticked folders) goes into “${first.title}”.` : "Nothing ticked: everything at the top, folders included, goes into a new version “v1”."}
      </p>
      <div className="editor-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={onClose}>Not now</button>
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await ws.migrateVersions(list.filter((f) => checked.has(f.id)).map((f) => f.id));
            setBusy(false);
          }}
        >
          Continue
        </button>
      </div>
    </Modal>
  );
}

function NewVersionDialog({ ws, data, from, onClose }: { ws: Workspace; data: ProjectData; from?: string; onClose: () => void }) {
  const vs = versionsOf(data.folders);
  const [src, setSrc] = useState(from ?? openVersion(data, ws.folder)?.id ?? "");
  const [name, setName] = useState(() => nextVersionTitle(data.folders));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const err = await ws.newVersion(src, name.trim());
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  return (
    <Modal onClose={onClose} label="New version" size="sm">
      <h3 className="dialog-title">New version from {folderName(vs.find((v) => v.id === src))}</h3>
      <p className="chat-sub">A full copy: canvases, frames, folders, cards, links, images and tags. Suggestions, chats and the Trash stay behind.</p>
      <label className="version-field">
        Name
        <input className="name-input" value={name} maxLength={80} autoFocus onChange={(e) => (setName(e.target.value), setError(null))} onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && void submit()} />
      </label>
      <label className="version-field">
        From
        <select value={src} onChange={(e) => setSrc(e.target.value)}>
          {[...vs].reverse().map((v) => (
            <option key={v.id} value={v.id}>{folderName(v)}</option>
          ))}
        </select>
      </label>
      {error && <p className="setup-error" role="alert">{error}</p>}
      <div className="editor-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!name.trim() || !src || busy} onClick={() => void submit()}>{busy ? "Copying…" : "Create"}</button>
      </div>
    </Modal>
  );
}

function RenameVersionDialog({ ws, data, id, onClose }: { ws: Workspace; data: ProjectData; id: string; onClose: () => void }) {
  const v = data.folders.find((f) => f.id === id);
  const [name, setName] = useState(v?.title ?? "");
  const n = name.trim();
  const taken = versionsOf(data.folders).some((f) => f.id !== id && f.title.trim().toLowerCase() === n.toLowerCase());
  const ok = !!n && !taken;
  const save = () => {
    if (!ok) return;
    ws.updateFolder(id, { title: n }, "rename version");
    onClose();
  };
  return (
    <Modal onClose={onClose} label="Rename version" size="sm">
      <h3 className="dialog-title">Rename version</h3>
      <input className="name-input" aria-label="Version name" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
      {taken && <p className="setup-error" role="alert">There is already a version named “{n}”.</p>}
      <div className="editor-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!ok} onClick={save}>Rename</button>
      </div>
    </Modal>
  );
}

// ----- compare -----

type Row =
  | { kind: "new"; b: Card }
  | { kind: "removed"; a: Card }
  | { kind: "changed"; a: Card; b: Card; what: string[] }
  | { kind: "same"; a: Card; b: Card };

const sameJson = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
/** What differs between two cards of one lineage (the fields Apply copies). */
function changes(a: Card, b: Card): string[] {
  const out: string[] = [];
  if (a.title !== b.title) out.push("title");
  if (a.body !== b.body) out.push("body");
  if (!sameJson([...a.tags].sort(), [...b.tags].sort())) out.push("tags");
  if (a.stage !== b.stage) out.push("stage");
  if (!sameJson(a.fields, b.fields)) out.push("fields");
  return out;
}

/** Pairs A's and B's cards by lineage (origin chains, either way) and sorts them into rows. */
export function compareVersions(cards: Card[], of: Map<string, string>, a: string, b: string): Row[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const ancestors = (c: Card) => {
    const out: string[] = [];
    let cur: Card | undefined = c;
    for (let i = 0; cur?.origin && i < 64; i++) {
      out.push(cur.origin.card);
      cur = byId.get(cur.origin.card);
    }
    return out;
  };
  const live = cards.filter((c) => !c.ghost);
  const inA = live.filter((c) => of.get(c.id) === a);
  const inB = live.filter((c) => of.get(c.id) === b);
  const aIds = new Set(inA.map((c) => c.id));
  const matchedA = new Set<string>();
  const rows: Row[] = [];
  const ancOfA = new Map(inA.map((c) => [c.id, ancestors(c)]));
  for (const cb of inB) {
    const up = ancestors(cb).find((id) => aIds.has(id) && !matchedA.has(id));
    const ca = up ? byId.get(up) : inA.find((x) => !matchedA.has(x.id) && ancOfA.get(x.id)!.includes(cb.id));
    if (!ca) {
      rows.push({ kind: "new", b: cb });
      continue;
    }
    matchedA.add(ca.id);
    const what = changes(ca, cb);
    rows.push(what.length ? { kind: "changed", a: ca, b: cb, what } : { kind: "same", a: ca, b: cb });
  }
  for (const ca of inA) if (!matchedA.has(ca.id)) rows.push({ kind: "removed", a: ca });
  return rows;
}

function CompareVersions({ ws, data, a: a0, b: b0, card, onClose }: { ws: Workspace; data: ProjectData; a?: string; b?: string; card?: string; onClose: () => void }) {
  const vs = versionsOf(data.folders);
  const open = openVersion(data, ws.folder);
  const [b, setB] = useState(b0 ?? open?.id ?? "");
  const [a, setA] = useState(a0 ?? vs.find((v) => v.id === vs.find((x) => x.id === b)?.created_from)?.id ?? vs.find((v) => v.id !== b)?.id ?? "");
  const [only, setOnly] = useState(card);
  const [showSame, setShowSame] = useState(false);
  const [busy, setBusy] = useState(false);
  const of = useMemo(() => cardVersions(data), [data]);
  const rows = useMemo(() => compareVersions(data.cards, of, a, b).filter((r) => !only || ("a" in r && r.a.id === only) || ("b" in r && r.b.id === only)), [data.cards, of, a, b, only]);
  const nameA = folderName(vs.find((v) => v.id === a));
  const nameB = folderName(vs.find((v) => v.id === b));
  const groups: { kind: Row["kind"]; label: string }[] = [
    { kind: "new", label: `New in ${nameB}` },
    { kind: "changed", label: "Changed" },
    { kind: "removed", label: `Removed in ${nameB}` },
    { kind: "same", label: "Unchanged" },
  ];

  /** Copies the row's B side into A (one undo step each). */
  const apply = async (r: Row) => {
    if (r.kind === "new") {
      const c = r.b;
      await ws.createCard({ folder: a, title: c.title, body: c.body, tags: c.tags, stage: c.stage, fields: c.fields, kind: c.kind, items: c.items, attachments: c.attachments, color: c.color, origin: { card: c.id, version: b } });
    } else if (r.kind === "changed") {
      await ws.updateCard(r.a.id, { title: r.b.title, body: r.b.body, tags: r.b.tags, stage: r.b.stage, fields: r.b.fields });
    } else if (r.kind === "removed") {
      await ws.deleteCard(r.a.id);
    }
  };
  const applyAll = async () => {
    setBusy(true);
    for (const r of rows) if (r.kind !== "same") await apply(r);
    setBusy(false);
  };
  const jump = (id: string) => {
    onClose();
    void ws.focusCard(id);
  };
  const pick = (value: string, set: (v: string) => void, label: string) => (
    <label className="version-field">
      {label}
      <select value={value} onChange={(e) => set(e.target.value)}>
        {[...vs].reverse().map((v) => (
          <option key={v.id} value={v.id}>{folderName(v)}</option>
        ))}
      </select>
    </label>
  );
  const actionable = rows.filter((r) => r.kind !== "same").length;

  return (
    <Modal onClose={onClose} label="Compare versions" size="lg" placement="canvas" className="compare-modal version-compare">
      <div className="modal-head">
        <h3>Compare versions</h3>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconClose /></button>
      </div>
      <div className="version-pickers">
        {pick(a, setA, "A")}
        <span aria-hidden="true">→</span>
        {pick(b, setB, "B")}
        <div className="side-spacer" />
        {only && <button type="button" className="chip" onClick={() => setOnly(undefined)}>Show all cards</button>}
        {actionable > 0 && a !== b && (
          <button type="button" className="btn" disabled={busy} onClick={() => void applyAll()}>Apply all shown to {nameA}</button>
        )}
      </div>
      {a === b && <p className="chat-sub">Pick two different versions.</p>}
      {a !== b &&
        groups.map((g) => {
          const list = rows.filter((r) => r.kind === g.kind);
          if (!list.length) return null;
          const collapsed = g.kind === "same" && !showSame;
          return (
            <section key={g.kind} className="version-group">
              <h4>
                {g.kind === "same" ? (
                  <button type="button" className="chip" aria-expanded={!collapsed} onClick={() => setShowSame((v) => !v)}>{g.label} ({list.length})</button>
                ) : (
                  `${g.label} (${list.length})`
                )}
              </h4>
              {!collapsed &&
                list.map((r) => {
                  const c = "b" in r ? r.b : r.a;
                  return (
                    <div key={c.id} className="version-row">
                      <button type="button" className="version-row-title" title="Show this card on its canvas" onClick={() => jump(c.id)}>
                        {c.title || "Untitled"}
                      </button>
                      {r.kind === "changed" && <span className="chat-sub">{r.what.join(", ")}</span>}
                      <div className="side-spacer" />
                      {r.kind !== "same" && (
                        <button type="button" className="btn" disabled={busy} onClick={() => void apply(r)}>
                          {r.kind === "removed" ? `Trash in ${nameA}` : `Apply to ${nameA}`}
                        </button>
                      )}
                      {r.kind === "changed" && <ChangeDiff a={r.a} b={r.b} what={r.what} />}
                    </div>
                  );
                })}
            </section>
          );
        })}
      {a !== b && rows.length === 0 && <p className="chat-sub">No cards to compare.</p>}
    </Modal>
  );
}

function ChangeDiff({ a, b, what }: { a: Card; b: Card; what: string[] }) {
  return (
    <div className="version-diff compare-body">
      {what.includes("title") && <p><span className="diff-del">{a.title}</span> → <span className="diff-add">{b.title}</span></p>}
      {what.includes("stage") && <p>Stage: <span className="diff-del">{STAGE_LABEL[a.stage]}</span> → <span className="diff-add">{STAGE_LABEL[b.stage]}</span></p>}
      {what.includes("tags") && <p>Tags: <span className="diff-del">{a.tags.join(", ") || "none"}</span> → <span className="diff-add">{b.tags.join(", ") || "none"}</span></p>}
      {what.includes("fields") && <p>Fields changed</p>}
      {what.includes("body") && diffLines(a.body, b.body).map((d, i) => (d.kind === "same" ? <p key={i}>{d.text}</p> : <p key={i} className={`diff-${d.kind}`}>{d.text}</p>))}
    </div>
  );
}
