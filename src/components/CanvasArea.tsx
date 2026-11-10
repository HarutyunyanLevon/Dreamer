import { useMemo, useState, type CSSProperties } from "react";
import type { Card, ProjectData } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { IconCard, IconClip, IconFit, IconImage, IconLink, IconMinus, IconPlus } from "./Icons";

/**
 * Step 3: read-only rendering of real cards at their stored positions (so live file changes can be seen).
 * Drag, pan/zoom, editing, links, images: step 4.
 */
export function CanvasArea({ ws }: { ws: Workspace }) {
  const { data } = ws;
  const [filter, setFilter] = useState<Set<StageId>>(new Set(STAGES));
  const toggle = (s: StageId) =>
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const visible = useMemo(() => (data?.cards ?? []).filter((c) => filter.has(c.stage)), [data, filter]);
  const vp = data?.canvas.viewport ?? { x: 300, y: 110, zoom: 1 };
  const camera = { "--pan-x": `${vp.x}px`, "--pan-y": `${vp.y}px`, "--zoom": vp.zoom } as CSSProperties;
  const title = data?.meta.name ?? "";

  return (
    <main className="canvas" aria-label="Canvas" style={camera}>
      <div className="grid" />
      <div className="world">
        {data && visible.map((c) => <CardView key={c.id} card={c} pos={data.canvas.cards[c.id]} ws={ws} />)}
      </div>

      {data && data.cards.length === 0 && (
        <div className="empty">
          <div className="empty-title">{data.is_inbox ? "Your Inbox is empty" : "A blank canvas"}</div>
          <p>
            {data.is_inbox
              ? "Raw ideas land here. Capture one with the Card button for now; the global hotkey comes soon."
              : "Add your first card with the Card button below."}
          </p>
        </div>
      )}

      <div className="pill title-pill">
        <span className="proj-title">{title || "…"}</span>
        <span className="pill-sep" />
        <div className="stage-filter" role="group" aria-label="Stage filter">
          {STAGES.map((s) => (
            <button key={s} type="button" className={"filter" + (filter.has(s) ? " on" : "")} aria-pressed={filter.has(s)} onClick={() => toggle(s)}>
              <span className={`dot dot-${s}`} aria-hidden="true" />
              {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {data && data.warnings.length > 0 && <Warnings data={data} />}

      <div className="pill zoom-pill" aria-label="Zoom">
        <button type="button" className="icon-btn" aria-label="Zoom out" disabled title="Zoom arrives in step 4"><IconMinus /></button>
        <span className="zoom-val">{Math.round(vp.zoom * 100)}%</span>
        <button type="button" className="icon-btn" aria-label="Zoom in" disabled title="Zoom arrives in step 4"><IconPlus /></button>
        <button type="button" className="icon-btn" aria-label="Fit to content" disabled title="Fit arrives in step 4"><IconFit /></button>
      </div>

      <div className="pill toolbar" role="toolbar" aria-label="Add">
        <button type="button" className="tool" disabled={!data} onClick={() => void ws.createCard({ title: "New idea" })}>
          <IconCard />
          <span>Card</span>
        </button>
        <button type="button" className="tool" disabled title="Links arrive in step 4"><IconLink /><span>Link</span></button>
        <button type="button" className="tool" disabled title="Images arrive in step 4"><IconImage /><span>Image</span></button>
        <button type="button" className="tool" disabled title="Web clips arrive in step 4"><IconClip /><span>Web clip</span></button>
      </div>
    </main>
  );
}

function Warnings({ data }: { data: ProjectData }) {
  const n = data.warnings.length;
  return (
    <div className="pill warn-pill" role="status" title={data.warnings.join("\n")}>
      {n === 1 ? "1 card file couldn't be read" : `${n} card files couldn't be read`}
    </div>
  );
}

function CardView({ card, pos, ws }: { card: Card; pos?: { x: number; y: number }; ws: Workspace }) {
  if (!pos) return null;
  return (
    <article className={`card stage-${card.stage}` + (card.ghost ? " ghost" : "")} style={{ left: pos.x, top: pos.y }}>
      {card.ghost && <div className="ghost-label">Claude suggests</div>}
      <div className="card-head">
        <span className={`dot dot-${card.stage}`} aria-hidden="true" />
        <span className="stage-name">{STAGE_LABEL[card.stage]}</span>
      </div>
      <h3>{card.title}</h3>
      {card.body && <p className="card-body">{card.body}</p>}
      {card.tags.length > 0 && <div className="tags">{card.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
      {card.ghost && (
        <div className="ghost-actions">
          <button type="button" className="btn primary" onClick={() => void ws.updateCard(card.id, { ghost: false })}>Keep</button>
          <button type="button" className="btn" onClick={() => void ws.deleteCard(card.id)}>Dismiss</button>
        </div>
      )}
    </article>
  );
}
