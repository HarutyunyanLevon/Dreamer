import { useMemo } from "react";
import type { Card } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { diffLines } from "../util/diff";
import { IconClose, IconFork } from "./Icons";

export function branchGroup(card: Card): string | null {
  const b = card.branch as { group?: unknown } | null | undefined;
  return b && typeof b === "object" && typeof b.group === "string" ? b.group : null;
}

export function BranchCompare({ card, ws, onClose }: { card: Card; ws: Workspace; onClose: () => void }) {
  const group = branchGroup(card);
  const siblings = useMemo(() => (ws.data?.cards ?? []).filter((c) => branchGroup(c) === group).sort((a, b) => a.created.localeCompare(b.created)), [ws.data, group]);
  const baseline = siblings[0];

  const pickWinner = async (winner: Card) => {
    for (const s of siblings) {
      if (s.id !== winner.id) await ws.loseCard(s.id, `lost to "${winner.title}"`);
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal glass compare-modal">
        <div className="modal-head">
          <h3><IconFork /> Compare forks</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconClose /></button>
        </div>
        {siblings.length < 2 && <p className="chat-sub">No other forks left to compare — this is the only one standing.</p>}
        <div className="compare-columns">
          {siblings.map((s) => (
            <div key={s.id} className="compare-col">
              <h4>{s.title}</h4>
              <div className="compare-body">
                {s.id === baseline.id
                  ? s.body.split("\n").map((line, i) => <p key={i}>{line}</p>)
                  : diffLines(baseline.body, s.body).map((d, i) =>
                      d.kind === "same" ? <p key={i}>{d.text}</p> : <p key={i} className={`diff-${d.kind}`}>{d.text}</p>,
                    )}
              </div>
              {siblings.length >= 2 && (
                <button type="button" className="btn primary" onClick={() => void pickWinner(s)}>Pick this one</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
