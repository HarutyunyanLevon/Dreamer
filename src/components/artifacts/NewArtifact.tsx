import { useState } from "react";
import type { ArtifactType } from "../../api";
import { Modal } from "../../ui/Modal";
import { ARTIFACT_HINT, ARTIFACT_LABEL, ARTIFACT_TYPES } from "./prompts";
import { ArtifactIcon } from "./ArtifactIcon";

/** Canvas add-menu › New artifact: a type picker and a short brief. Create starts Claude on it. */
export function NewArtifactDialog({ initialType, onClose, onCreate }: { initialType?: ArtifactType; onClose: () => void; onCreate: (type: ArtifactType, title: string, brief: string) => void }) {
  const [type, setType] = useState<ArtifactType>(initialType ?? "character");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  return (
    <Modal onClose={onClose} label="New artifact" size="sm" className="new-artifact">
      <h3 className="dialog-title">New artifact</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!brief.trim()) return;
          onClose();
          onCreate(type, title.trim(), brief.trim());
        }}
      >
        <div className="artifact-types" role="radiogroup" aria-label="Type">
          {ARTIFACT_TYPES.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} className={"artifact-type" + (type === t ? " on" : "")} onClick={() => setType(t)} title={ARTIFACT_HINT[t]}>
              <ArtifactIcon type={t} />
              <span>{ARTIFACT_LABEL[t]}</span>
            </button>
          ))}
        </div>
        <p className="chat-sub">{ARTIFACT_HINT[type]}</p>
        <input className="name-input" value={title} placeholder="Title (optional)" aria-label="Title" onChange={(e) => setTitle(e.target.value)} />
        <textarea className="name-input artifact-brief" autoFocus value={brief} rows={4} placeholder="Brief: what should it show? e.g. The fish priest: a rusty diving-suit cleric who blesses bait" aria-label="Brief" onChange={(e) => setBrief(e.target.value)} />
        <p className="chat-sub">Made by Claude, with images from SpriteCook. Paid image calls stay under the per-turn cap in Settings.</p>
        <div className="editor-actions">
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!brief.trim()}>Create</button>
        </div>
      </form>
    </Modal>
  );
}
