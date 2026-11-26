import { useMemo } from "react";
import { type Card } from "../../api";
import { type Rect } from "../cardGeometry";
import { type GhostLink, type Workspace } from "../../state/workspace";

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

type RectOf = (id: string) => Rect | undefined;

/** Ghost links whose two cards are both on screen, with their endpoints. */
function placedGhosts(cards: Card[], rectOf: RectOf, ghosts: GhostLink[]) {
  const ids = new Set(cards.map((c) => c.id));
  return ghosts.flatMap((g) => {
    const a = rectOf(g.from);
    const b = rectOf(g.to);
    if (!a || !b || !ids.has(g.from) || !ids.has(g.to)) return [];
    const p1 = center(a);
    const p2 = center(b);
    return [{ g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
  });
}

/** Keep/Dismiss pill at the midpoint of each proposed (ghost) link. */
export function GhostLinkControls({ cards, rectOf, ghosts, ws }: { cards: Card[]; rectOf: RectOf; ghosts: GhostLink[]; ws: Workspace }) {
  return (
    <>
      {placedGhosts(cards, rectOf, ghosts).map(({ g, x1, y1, x2, y2 }) => (
        <div
          key={g.key}
          className="ghost-link-ctl"
          data-wheel-boundary=""
          style={{ left: (x1 + x2) / 2, top: (y1 + y2) / 2 }}
          title={g.reason}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="ghost-link-label">{g.label || "Claude suggests a link"}</span>
          <button type="button" className="btn primary" onClick={() => void ws.keepGhostLink(g)}>Keep</button>
          <button type="button" className="btn" onClick={() => ws.dismissGhostLink(g)}>Dismiss</button>
        </div>
      ))}
    </>
  );
}

export function LinkLayer({ cards, rectOf, ghosts }: { cards: Card[]; rectOf: RectOf; ghosts: GhostLink[] }) {
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const ghostLines = placedGhosts(cards, rectOf, ghosts);
  const lines: { x1: number; y1: number; x2: number; y2: number; label?: string; key: string; from: string; to: string }[] = [];
  for (const c of cards) {
    const from = rectOf(c.id);
    if (!from) continue;
    for (const l of c.links) {
      const to = rectOf(l.to);
      if (!to || !byId.has(l.to)) continue;
      const a = center(from);
      const b = center(to);
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, label: l.label, key: `${c.id}-${l.to}`, from: c.id, to: l.to });
    }
  }
  if (lines.length === 0 && ghostLines.length === 0) return null;
  const pad = 4000;
  return (
    <svg className="link-layer" width={pad * 2} height={pad * 2} style={{ left: -pad, top: -pad }}>
      <g transform={`translate(${pad},${pad})`}>
        {lines.map((l) => (
          <g key={l.key} className="link">
            <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="link-line" />
            {/* Wide invisible stroke: makes the line easy to right-click. */}
            <line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className="link-hit" data-link-from={l.from} data-link-to={l.to} />
            {l.label && (
              <text x={(l.x1 + l.x2) / 2} y={(l.y1 + l.y2) / 2} className="link-label" textAnchor="middle">
                {l.label}
              </text>
            )}
          </g>
        ))}
        {ghostLines.map(({ g, x1, y1, x2, y2 }) => (
          <line key={`ghost-${g.key}`} x1={x1} y1={y1} x2={x2} y2={y2} className="link-line ghost-link" />
        ))}
      </g>
    </svg>
  );
}

/** What an artifact card can ask the canvas to do. */
