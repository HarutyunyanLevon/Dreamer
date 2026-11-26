import { useEffect, useMemo, useState } from "react";
import { api, type Card, type Link } from "../api";
import { CARD_H, CARD_W } from "./cardGeometry";
import { cardVersions, folderName, type Workspace } from "../state/useWorkspace";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { renderMarkdown } from "../util/markdown";
import { Modal } from "../ui/Modal";
import { BranchCompare, branchGroup } from "./BranchCompare";
import { IconClose, IconFork, IconTrash } from "./Icons";
import { ScrollArea } from "../ui/Scroll";
import { asUrl } from "../util/media";
import { AttachmentsEditor, imageFiles } from "./Attachments";
import { ChecklistBody, hasStage } from "./kinds";
import { BuildTab } from "./BuildTab";
import { needsRebuild } from "../util/build";

/** Keys the app manages itself (legacy media keys, a label's size): hidden here, kept on save. */
const RESERVED_FIELDS = new Set(["image", "url", "clip_title", "size", "split_offer"]);

/** "+ More" open/closed is remembered per card (only meaningful once it holds values). */
const moreKey = (id: string) => `dreamer.more.${id}`;
function readMore(id: string): boolean {
  try {
    return localStorage.getItem(moreKey(id)) === "1";
  } catch {
    return false;
  }
}
function writeMore(id: string, open: boolean) {
  try {
    localStorage.setItem(moreKey(id), open ? "1" : "0");
  } catch {
    /* storage unavailable: the toggle just isn't remembered */
  }
}

/** Unsaved edits are kept as a draft when the editor switches to another card, and restored on reopen. */
type Draft = { title: string; stage: StageId; body: string; tags: string[]; fields: [string, string][] };
const draftKey = (id: string) => `dreamer.draft.${id}`;
function readDraft(id: string): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as Draft) : null;
  } catch {
    return null;
  }
}
function writeDraft(id: string, d: Draft | null) {
  try {
    if (d) localStorage.setItem(draftKey(id), JSON.stringify(d));
    else localStorage.removeItem(draftKey(id));
  } catch {
    /* storage unavailable: the draft is lost */
  }
}
const baseFields = (card: Card): [string, string][] =>
  Object.entries(card.fields).filter(([k]) => !RESERVED_FIELDS.has(k)).map(([k, v]) => [k, String(v)]);

export function CardEditor({
  card,
  ws,
  onClose,
  dirtyRef,
  switchTo,
  onSwitch,
  onStay,
  initialTab = "card",
}: {
  card: Card;
  /** The Build board opens cards on their Build tab. */
  initialTab?: "card" | "build";
  ws: Workspace;
  onClose: () => void;
  /** Kept current with "has unsaved edits", for the host's chat-driven card switching. */
  dirtyRef?: { current: boolean };
  /** A chat link asked to open another card while this one has edits: show the inline confirm. */
  switchTo?: { id: string; title: string } | null;
  onSwitch?: (id: string) => void;
  onStay?: () => void;
}) {
  const [init] = useState(() => readDraft(card.id));
  const [title, setTitle] = useState(init?.title ?? card.title);
  const [stage, setStage] = useState<StageId>(init?.stage ?? card.stage);
  const [body, setBody] = useState(init?.body ?? card.body);
  const [tags, setTags] = useState<string[]>(init?.tags ?? card.tags);
  const [tagInput, setTagInput] = useState("");
  const [fields, setFields] = useState<[string, string][]>(init?.fields ?? baseFields(card));
  const dirty =
    title !== card.title ||
    stage !== card.stage ||
    body !== card.body ||
    JSON.stringify(tags) !== JSON.stringify(card.tags) ||
    JSON.stringify(fields) !== JSON.stringify(baseFields(card));
  if (dirtyRef) dirtyRef.current = dirty;
  useEffect(() => () => { if (dirtyRef) dirtyRef.current = false; }, [dirtyRef]);
  /** Closing discards the edits (and any stored draft). */
  const close = () => {
    writeDraft(card.id, null);
    onClose();
  };
  const [tab, setTab] = useState<"card" | "build">(initialTab);
  const [preview, setPreview] = useState(false);
  const [comparing, setComparing] = useState(false);
  const hasExtras = fields.length > 0;
  const [moreOpen, setMoreOpen] = useState(() => hasExtras && readMore(card.id));
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    if (hasExtras || next) writeMore(card.id, next);
  };
  const group = branchGroup(card);
  // Lineage across project versions: "from v1" opens Compare for this card and its origin.
  const originVersion = card.origin ? ws.data?.folders.find((f) => f.id === card.origin!.version) : undefined;
  const staged = hasStage(card);
  const isLabel = card.kind === "label";

  const byId = useMemo(() => new Map((ws.data?.cards ?? []).map((c) => [c.id, c])), [ws.data]);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  };

  const persist = async () => {
    const fieldsObj: Record<string, unknown> = Object.fromEntries(Object.entries(card.fields).filter(([k]) => RESERVED_FIELDS.has(k)));
    for (const [k, v] of fields) if (k.trim()) fieldsObj[k.trim()] = v;
    await ws.updateCard(card.id, { title, stage, body, tags, fields: fieldsObj });
  };

  const save = async () => {
    // An unchanged save of a Claude suggestion must not Keep it (editing a ghost keeps it).
    if (dirty || !card.ghost) await persist();
    close();
  };

  // Paste adds images; a pasted link becomes a web clip (except while typing in a text field).
  const onPaste = (e: React.ClipboardEvent) => {
    const files = imageFiles(e.clipboardData.items);
    if (files.length) {
      e.preventDefault();
      void ws.addImages(card.id, files);
      return;
    }
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, [contenteditable]")) return;
    const url = asUrl(e.clipboardData.getData("text/plain"));
    if (url) {
      e.preventDefault();
      void ws.addClip(card.id, url);
    }
  };

  return (
    <>
      <Modal onClose={close} label={`Edit card ${title || "Untitled"}`} size="lg" placement="canvas" className="card-editor" onPaste={onPaste}>
        <div className="modal-head">
          <input className="editor-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}><IconClose /></button>
        </div>

        {switchTo && (
          <div className="switch-ask" role="alertdialog" aria-label="Switch card">
            <span>Switch to “{switchTo.title || "Untitled"}”? Your edits stay as a draft.</span>
            <button type="button" className="btn primary" onClick={() => { writeDraft(card.id, { title, stage, body, tags, fields }); onSwitch?.(switchTo.id); }}>Switch</button>
            <button type="button" className="btn" onClick={onStay}>Stay</button>
          </div>
        )}

        {card.build && (
          <div className="editor-tabs" role="tablist" aria-label="Card sections">
            <button type="button" role="tab" aria-selected={tab === "card"} className={"filter" + (tab === "card" ? " on" : "")} onClick={() => setTab("card")}>Card</button>
            <button type="button" role="tab" aria-selected={tab === "build"} className={"filter" + (tab === "build" ? " on" : "")} onClick={() => setTab("build")}>
              Build{needsRebuild(card) && <span className="rebuild-pill" style={{ marginLeft: 6 }}>Needs rebuild</span>}
            </button>
          </div>
        )}

        {tab === "build" && card.build ? <BuildTab card={card} ws={ws} /> : (
        <>
        {(staged || group || originVersion) && (
        <div className="editor-row">
          <div className="stage-filter" role="group" aria-label="Stage">
            {staged && STAGES.map((s) => (
              <button key={s} type="button" className={"filter" + (stage === s ? " on" : "")} aria-pressed={stage === s} onClick={() => setStage(s)}>
                <span className={`dot dot-${s}`} aria-hidden="true" />
                {STAGE_LABEL[s]}
              </button>
            ))}
            {group && (
              <button type="button" className="chip fork-chip" onClick={() => setComparing(true)}>
                <IconFork /> Compare forks
              </button>
            )}
            {originVersion && ws.data && (
              <button
                type="button"
                className="chip origin-chip"
                title={`Copied from ${folderName(originVersion)}: compare with the original`}
                onClick={() => ws.setVersionDialog({ kind: "compare", a: originVersion.id, b: cardVersions(ws.data!).get(card.id), card: card.id })}
              >
                from {folderName(originVersion)}
              </button>
            )}
          </div>
        </div>
        )}

        {card.kind === "checklist" && (
          <div className="editor-row checklist-row">
            <ChecklistBody
              card={card}
              roomy
              onItems={(items) => void ws.updateCard(card.id, { items })}
              onDelete={(ids) => void ws.deleteChecklistItems(card.id, ids)}
              titleOf={(id) => byId.get(id)?.title}
            />
          </div>
        )}

        {!!card.fields.split_offer && <SplitChip card={card} ws={ws} />}

        {!isLabel && <AttachmentsEditor card={card} ws={ws} />}

        {!isLabel && (
        <div className="editor-row body-row">
          <div className="editor-row-head">
            <span className="side-label">Notes</span>
            <button type="button" className="chip" onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</button>
          </div>
          {preview ? (
            <ScrollArea className="md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
          ) : (
            <textarea className="editor-body scroll scroll-y" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write markdown notes…" aria-label="Notes" />
          )}
        </div>
        )}

        <div className="editor-row">
          <span className="side-label">Tags</span>
          <div className="tags editable">
            {tags.map((t) => (
              <span key={t} className="tag removable">
                {t}
                <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))}><IconClose /></button>
              </span>
            ))}
            <input
              className="tag-input"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              placeholder="Add tag…"
            />
          </div>
        </div>

        <div className="editor-row">
          <button type="button" className="chip more-toggle" aria-expanded={moreOpen} aria-controls="card-more" onClick={toggleMore}>
            {moreOpen ? "− Less" : "+ More"}
            {!moreOpen && hasExtras && <span className="more-count">{fields.length}</span>}
          </button>
        </div>

        {moreOpen && (
        <div id="card-more" className="more-section">
        <div className="editor-row">
          <span className="side-label">Custom fields</span>
          <p className="helper">Your own key/value pairs, such as “Mood: chaotic”.</p>
          {fields.map(([k, v], i) => (
            <div key={i} className="field-row">
              <input value={k} placeholder="key" onChange={(e) => setFields(fields.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} />
              <input value={v} placeholder="value" onChange={(e) => setFields(fields.map((f, j) => (j === i ? [f[0], e.target.value] : f)))} />
              <button type="button" className="icon-btn" aria-label="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== i))}><IconClose /></button>
            </div>
          ))}
          <button type="button" className="chip" onClick={() => setFields([...fields, ["", ""]])}>+ Field</button>
        </div>

        </div>
        )}

        {card.links.length > 0 && (
          <div className="editor-row">
            <span className="side-label">Links</span>
            {card.links.map((l) => (
              <LinkRow key={l.to} link={l} title={byId.get(l.to)?.title ?? l.to} onRemove={() => ws.removeLink(card.id, l.to)} onLabel={(label) => ws.setLinkLabel(card.id, l.to, label)} />
            ))}
          </div>
        )}

        </>
        )}

        <div className="editor-actions">
          <button type="button" className="btn" onClick={() => void ws.deleteCard(card.id).then(close)}><IconTrash /><span>Delete</span></button>
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()}>Save</button>
        </div>
      </Modal>
      {comparing && <BranchCompare card={card} ws={ws} onClose={() => { setComparing(false); close(); }} />}
    </>
  );
}

function LinkRow({ link, title, onRemove, onLabel }: { link: Link; title: string; onRemove: () => void; onLabel: (label: string) => void }) {
  const [label, setLabel] = useState(link.label ?? "");
  return (
    <div className="field-row">
      <span className="link-target">{title}</span>
      <input value={label} placeholder="label" onChange={(e) => setLabel(e.target.value)} onBlur={() => onLabel(label)} />
      <button type="button" className="icon-btn" aria-label={`Remove link to ${title}`} onClick={onRemove}><IconClose /></button>
    </div>
  );
}

/** Long pasted text: split it into ghost cards on the local model (Claude only on "Think harder"). */
function SplitChip({ card, ws }: { card: Card; ws: Workspace }) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const source = `${card.title}\n${card.body}`.trim();
  const done = () => ws.updateCard(card.id, { fields: Object.fromEntries(Object.entries(card.fields).filter(([k]) => k !== "split_offer")) });
  const split = async () => {
    setBusy(true);
    try {
      const r = await api.splitText(source);
      const at = ws.data?.canvas.cards[card.id] ?? { x: 0, y: 0 };
      const n = r.cards.length;
      for (const [i, c] of r.cards.entries()) {
        // A row under the original, centred on it.
        await ws.createCard({ title: c.title, body: c.body, tags: c.tags, stage: "mist", ghost: true, links: [{ to: card.id, label: "split from" }], x: at.x + (i - (n - 1) / 2) * (CARD_W + 40), y: at.y + CARD_H + 80 });
      }
      if (n) await done();
      ws.toast(n ? `${n} card${n === 1 ? "" : "s"} suggested${r.warnings.length ? ` (${r.warnings.length} dropped: not in your text)` : ""}.` : r.warnings.join(" ") || "Nothing to split.");
    } catch (e) {
      ws.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const harder = async () => {
    setMenu(false);
    await done();
    ws.setContextCard(card.id);
    ws.requestChat({ text: `Split this card into separate cards, one idea each. Use only my own text: don't add ideas. Propose them as ghost cards linked "split from" this card.`, thread: card.id, send: true });
  };
  return (
    <div className="editor-row split-chip">
      <button type="button" className="chip" disabled={busy} onClick={() => void split()}>{busy ? "Splitting…" : "Split into cards"}</button>
      <button type="button" className="chip" aria-label="More ways to split" aria-expanded={menu} onClick={() => setMenu(!menu)}>▾</button>
      {menu && (
        <span className="split-menu">
          <button type="button" className="chip" title="Ask Claude instead of the local model" onClick={() => void harder()}>Think harder</button>
          <button type="button" className="chip" onClick={() => void done()}>Hide</button>
        </span>
      )}
    </div>
  );
}
