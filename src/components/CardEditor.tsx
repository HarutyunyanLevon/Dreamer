import { useEffect, useMemo, useState } from "react";
import { api, type Card, type Link } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { renderMarkdown } from "../util/markdown";
import { BranchCompare, branchGroup } from "./BranchCompare";
import { IconClose, IconFork, IconTrash } from "./Icons";

const RESERVED_FIELDS = new Set(["image", "url", "clip_title"]);

export function CardEditor({ card, ws, onClose }: { card: Card; ws: Workspace; onClose: () => void }) {
  const [title, setTitle] = useState(card.title);
  const [stage, setStage] = useState<StageId>(card.stage);
  const [body, setBody] = useState(card.body);
  const [tags, setTags] = useState<string[]>(card.tags);
  const [tagInput, setTagInput] = useState("");
  const [fields, setFields] = useState<[string, string][]>(
    Object.entries(card.fields).filter(([k]) => !RESERVED_FIELDS.has(k)).map(([k, v]) => [k, String(v)]),
  );
  const [url, setUrl] = useState(typeof card.fields.url === "string" ? card.fields.url : "");
  const [preview, setPreview] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [briefMsg, setBriefMsg] = useState<string | null>(null);
  const group = branchGroup(card);

  const exportBrief = async () => {
    if (!ws.active) return;
    try {
      await persist();
      const path = await api.exportBrief(ws.active, card.id);
      setBriefMsg(`Exported to ${path}`);
    } catch (e) {
      setBriefMsg(e instanceof Error ? e.message : String(e));
    }
    setTimeout(() => setBriefMsg(null), 4000);
  };

  const imageRel = typeof card.fields.image === "string" ? card.fields.image : null;
  useEffect(() => {
    if (!imageRel || !ws.active) {
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    api.readMedia(ws.active, imageRel).then((u) => !cancelled && setImageUrl(u)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [imageRel, ws.active]);

  const byId = useMemo(() => new Map((ws.data?.cards ?? []).map((c) => [c.id, c])), [ws.data]);

  const addTag = () => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  };

  const persist = async () => {
    const fieldsObj: Record<string, unknown> = {};
    for (const [k, v] of fields) if (k.trim()) fieldsObj[k.trim()] = v;
    if (imageRel) fieldsObj.image = imageRel;
    if (url.trim()) fieldsObj.url = url.trim();
    if (typeof card.fields.clip_title === "string") fieldsObj.clip_title = card.fields.clip_title;
    await ws.updateCard(card.id, { title, stage, body, tags, fields: fieldsObj });
  };

  const save = async () => {
    await persist();
    onClose();
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    await ws.addImage(card.id, file, file.name || "pasted.png");
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card-editor glass" onPaste={onPaste}>
        <div className="modal-head">
          <input className="editor-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconClose /></button>
        </div>

        <div className="editor-row">
          <div className="stage-filter" role="group" aria-label="Stage">
            {STAGES.map((s) => (
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
          </div>
        </div>

        {imageUrl && (
          <div className="editor-image">
            <img src={imageUrl} alt="" />
            <button type="button" className="btn" onClick={() => void ws.updateCard(card.id, { fields: { ...card.fields, image: undefined } })}>
              Remove image
            </button>
          </div>
        )}

        <div className="editor-row body-row">
          <div className="editor-row-head">
            <span className="side-label">Notes</span>
            <button type="button" className="chip" onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</button>
          </div>
          {preview ? (
            <div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
          ) : (
            <textarea className="editor-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste an image, or write markdown notes…" rows={7} />
          )}
        </div>

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
          <span className="side-label">Custom fields</span>
          {fields.map(([k, v], i) => (
            <div key={i} className="field-row">
              <input value={k} placeholder="key" onChange={(e) => setFields(fields.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} />
              <input value={v} placeholder="value" onChange={(e) => setFields(fields.map((f, j) => (j === i ? [f[0], e.target.value] : f)))} />
              <button type="button" className="icon-btn" aria-label="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== i))}><IconClose /></button>
            </div>
          ))}
          <button type="button" className="chip" onClick={() => setFields([...fields, ["", ""]])}>+ Field</button>
        </div>

        <div className="editor-row">
          <span className="side-label">Web clip URL</span>
          <input className="name-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>

        {card.links.length > 0 && (
          <div className="editor-row">
            <span className="side-label">Links</span>
            {card.links.map((l) => (
              <LinkRow key={l.to} link={l} title={byId.get(l.to)?.title ?? l.to} onRemove={() => ws.removeLink(card.id, l.to)} onLabel={(label) => ws.setLinkLabel(card.id, l.to, label)} />
            ))}
          </div>
        )}

        {briefMsg && <p className="chat-sub">{briefMsg}</p>}
        <div className="editor-actions">
          <button type="button" className="btn" onClick={() => void ws.deleteCard(card.id).then(onClose)}><IconTrash /><span>Delete</span></button>
          <button
            type="button"
            className="btn"
            disabled={stage !== "pitch"}
            title={stage !== "pitch" ? "Unlocks when the card reaches Pitch" : "Export a Markdown design brief"}
            onClick={() => void exportBrief()}
          >
            Export brief
          </button>
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()}>Save</button>
        </div>
      </div>
      {comparing && <BranchCompare card={card} ws={ws} onClose={() => { setComparing(false); onClose(); }} />}
    </div>
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
