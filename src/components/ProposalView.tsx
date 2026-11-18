import { useState } from "react";
import { api, type Card, type CardPatch, type EditProposal } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { STAGE_LABEL } from "../theme/types";
import { diffLines } from "../util/diff";
import { Modal } from "../ui/Modal";
import { ScrollArea } from "../ui/Scroll";
import { DuskStrip } from "./DuskGlass";
import { IconClose, IconSparkle } from "./Icons";

/** The card patch a proposal amounts to, against the card as it is now. Only real changes. */
export function proposalPatch(card: Card, p: EditProposal): CardPatch {
  const patch: CardPatch = {};
  if (p.title !== undefined && p.title !== card.title) patch.title = p.title;
  if (p.body !== undefined && p.body !== card.body) patch.body = p.body;
  if (p.tags && p.tags.join("\u0000") !== card.tags.join("\u0000")) patch.tags = p.tags;
  if (p.stage && p.stage !== card.stage) patch.stage = p.stage;
  const caps = p.captions ?? {};
  if (Object.keys(caps).some((id) => card.attachments.some((a) => a.id === id && (a.caption ?? "") !== caps[id]))) {
    patch.attachments = card.attachments.map((a) => (a.id in caps ? { ...a, caption: caps[a.id] || undefined } : a));
  }
  return patch;
}

/**
 * "Claude suggests changes": what propose_edit would change on one card, as a diff. Keep applies
 * it as one undoable card edit and removes the proposal file; Dismiss only removes the file.
 */
export function ProposalView({ card, proposal, ws, onClose }: { card: Card; proposal: EditProposal; ws: Workspace; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const patch = proposalPatch(card, proposal);
  const empty = Object.keys(patch).length === 0;
  const caps = proposal.captions ?? {};

  const settle = async (keep: boolean) => {
    const slug = ws.active;
    if (!slug) return;
    setBusy(true);
    try {
      if (keep && !empty && !(await ws.updateCard(card.id, patch))) return;
      await api.dismissProposal(slug, card.id);
      onClose();
    } catch (e) {
      ws.setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Claude suggests changes" size="lg" placement="canvas" className="proposal-modal">
      <DuskStrip seed={card.id} className="modal-head modal-dusk-head">
        <h3 className="dusk-pill"><IconSparkle /> Claude suggests changes</h3>
        <button type="button" className="icon-btn dusk-close" aria-label="Close" onClick={onClose}><IconClose /></button>
      </DuskStrip>
      {proposal.reason && <p className="proposal-reason">{proposal.reason}</p>}
      <ScrollArea className="proposal-body">
        {empty && <p className="chat-sub">The card already matches this suggestion.</p>}
        {patch.title !== undefined && (
          <section>
            <h4>Title</h4>
            <p className="diff-del">{card.title}</p>
            <p className="diff-add">{patch.title}</p>
          </section>
        )}
        {patch.stage && (
          <section>
            <h4>Stage</h4>
            <p><span className="diff-del">{STAGE_LABEL[card.stage]}</span> → <span className="diff-add">{STAGE_LABEL[patch.stage]}</span></p>
          </section>
        )}
        {patch.tags && (
          <section>
            <h4>Tags</h4>
            <div className="tags">
              {card.tags.filter((t) => !patch.tags!.includes(t)).map((t) => <span key={`-${t}`} className="tag diff-del">{t}</span>)}
              {patch.tags.map((t) => <span key={t} className={"tag" + (card.tags.includes(t) ? "" : " diff-add")}>{t}</span>)}
            </div>
          </section>
        )}
        {patch.body !== undefined && (
          <section>
            <h4>Notes</h4>
            <div className="compare-body">
              {diffLines(card.body, patch.body).map((d, i) => (d.kind === "same" ? <p key={i}>{d.text || " "}</p> : <p key={i} className={`diff-${d.kind}`}>{d.text || " "}</p>))}
            </div>
          </section>
        )}
        {patch.attachments && (
          <section>
            <h4>Captions</h4>
            {card.attachments.filter((a) => a.id in caps && (a.caption ?? "") !== caps[a.id]).map((a) => (
              <div key={a.id} className="proposal-caption">
                <span className="chat-sub">{a.type === "clip" ? a.title || a.url : "Image"}</span>
                {a.caption && <p className="diff-del">{a.caption}</p>}
                <p className="diff-add">{caps[a.id] || "(no caption)"}</p>
              </div>
            ))}
          </section>
        )}
      </ScrollArea>
      <div className="editor-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" disabled={busy} onClick={() => void settle(false)}>Dismiss</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void settle(true)}>Keep</button>
      </div>
    </Modal>
  );
}
