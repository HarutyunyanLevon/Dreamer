import { useEffect, useState } from "react";
import { api, type TrashItem } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { STAGE_LABEL } from "../theme/types";
import { IconClose, IconTrash } from "./Icons";

export function TrashView({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  const load = () => {
    if (ws.active) void api.listTrash(ws.active).then(setItems);
  };
  useEffect(load, [ws.active]);

  const restore = async (id: string) => {
    if (!ws.active) return;
    await api.restoreCard(ws.active, id);
    await ws.refresh();
    load();
  };

  const empty = async () => {
    if (!ws.active) return;
    await api.emptyTrash(ws.active);
    setConfirmEmpty(false);
    load();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal glass trash-modal">
        <div className="modal-head">
          <h3><IconTrash /> Trash</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconClose /></button>
        </div>

        {items.length === 0 && <p className="chat-sub">Nothing in the trash for this project.</p>}

        <div className="trash-list">
          {items.map((item) => (
            <div key={item.id} className="trash-row">
              <span className={`dot dot-${item.stage}`} aria-hidden="true" />
              <div className="trash-row-info">
                <div className="trash-title">{item.title}</div>
                <div className="chat-sub">{STAGE_LABEL[item.stage]} · {item.reason}</div>
              </div>
              <button type="button" className="btn" onClick={() => void restore(item.id)}>Restore</button>
            </div>
          ))}
        </div>

        {items.length > 0 && (
          <div className="editor-actions">
            <div className="side-spacer" />
            {confirmEmpty ? (
              <>
                <span className="chat-sub">Permanently delete {items.length} card{items.length === 1 ? "" : "s"}?</span>
                <button type="button" className="btn" onClick={() => setConfirmEmpty(false)}>Cancel</button>
                <button type="button" className="btn primary" onClick={() => void empty()}>Yes, empty trash</button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirmEmpty(true)}>Empty trash…</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
