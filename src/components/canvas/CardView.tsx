import { memo, useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { type Card, type Pos } from "../../api";
import { renderMarkdown } from "../../util/markdown";
import { CARD_W, HANDLES, resizeRect, type HandleDir, type Rect } from "../cardGeometry";
import { type Workspace } from "../../state/workspace";
import { STAGE_LABEL } from "../../theme/types";
import { ScrollArea } from "../../ui/Scroll";
import { branchGroup } from "../BranchCompare";
import { ChecklistBody, ClipBody, DECISIONS_TITLE, ImageBody, TECH_TITLE, hasStage, openQuestions } from "../kinds";
import { IconCheck, IconChecklist, IconPin, IconSparkle } from "../Icons";
import { CardAttachments, isClip, isImage } from "../Attachments";
import { DuskStrip, useDuskGlass } from "../DuskGlass";
import { ArtifactCardBody, ArtifactHead } from "../artifacts/ArtifactCard";

export type ArtifactActions = { chip: (id: string, prompt: string, label: string) => void; open: (id: string) => void; settings: () => void };

type CardActions = Pick<Workspace, "moveCard" | "resizeCard" | "flushCanvas" | "bringToFront" | "updateCard" | "deleteCard" | "keepGhostCard" | "deleteChecklistItems" | "startChecklistGrill"> & { titleOf: (id: string) => string | undefined };
type CardDrag = { unpin: (id: string) => void };

const currentZoom = () => Number((document.querySelector(".canvas") as HTMLElement | null)?.dataset.zoom) || 1;

export const CardView = memo(function CardView({
  card,
  pos,
  z,
  active,
  actions: ws,
  linking,
  isLinkSource,
  selected,
  onOpen,
  onPrompt,
  proposed,
  onProposal,
  onMenu,
  onMeasure,
  onAttachment,
  drag,
  artifact,
}: {
  card: Card;
  pos?: Pos;
  z: number;
  active: string | null;
  actions: CardActions;
  linking: boolean;
  isLinkSource: boolean;
  selected: boolean;
  onOpen: (card: Card, additive?: boolean) => void;
  onPrompt: (id: string) => void;
  /** A Claude edit proposal is pending for this card. */
  proposed: boolean;
  onProposal: (id: string) => void;
  onMenu: (id: string, x: number, y: number, stage?: boolean) => void;
  onMeasure: (id: string, h: number) => void;
  onAttachment: (cardId: string, attId: string, anchor: DOMRect) => void;
  drag: CardDrag;
  /** Artifact cards: run a suggestion chip, open the full-size view, open Settings (SpriteCook). */
  artifact: ArtifactActions;
}) {
  const elRef = useRef<HTMLElement | null>(null);

  // Report the rendered height (auto-height cards grow with their content).
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    onMeasure(card.id, el.offsetHeight);
    const ro = new ResizeObserver(() => onMeasure(card.id, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [card.id, onMeasure]);

  const bodyHtml = useMemo(() => (card.body ? renderMarkdown(card.body) : ""), [card.body]);
  // A ghost (Claude's suggested card) is dusk glass: a starry frame around a frosted panel.
  useDuskGlass(elRef, card.ghost ? "card" : null, card.id);

  // ----- move -----
  const dragState = useRef<{ x: number; y: number; ox: number; oy: number; zoom: number; moved: boolean; last: { x: number; y: number } } | null>(null);
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0 || linking) return;
      const t = e.target as HTMLElement;
      // Let the card body's own scrollbar be dragged.
      if (t.classList.contains("scroll") && e.nativeEvent.offsetX >= t.clientWidth) return;
      if (t.closest("button, a, input, textarea")) return;
      e.stopPropagation();
      // The last card you touch comes to the front.
      ws.bringToFront(card.id);
      dragState.current = { x: e.clientX, y: e.clientY, ox: pos?.x ?? 0, oy: pos?.y ?? 0, zoom: currentZoom(), moved: false, last: { x: pos?.x ?? 0, y: pos?.y ?? 0 } };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [pos, linking, ws, card.id, drag],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragState.current;
      if (!d) return;
      const dx = (e.clientX - d.x) / d.zoom;
      const dy = (e.clientY - d.y) / d.zoom;
      // A pinned card stays put (a click still opens it).
      if (pos?.pinned) return;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      if (d.moved) {
        d.last = { x: d.ox + dx, y: d.oy + dy };
        ws.moveCard(card.id, d.last);
      }
    },
    [card.id, ws, pos?.pinned],
  );
  // A cancelled press (window lost focus, gesture took over) keeps a move but never opens the card.
  const onPointerCancel = useCallback(() => {
    const d = dragState.current;
    dragState.current = null;
    if (d?.moved) {
      ws.moveCard(card.id, d.last, { undoable: true, from: { x: d.ox, y: d.oy } });
      void ws.flushCanvas();
    }
  }, [ws, card.id, drag]);
  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    const d = dragState.current;
    dragState.current = null;
    if (!d) return;
    if (d.moved) {
      ws.moveCard(card.id, d.last, { undoable: true, from: { x: d.ox, y: d.oy } });
      void ws.flushCanvas();
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    // A plain click on an image / clip tile opens the picture or the link (the menu's Open edits it).
    const att = !additive && !linking && (card.kind === "image" ? card.attachments.find(isImage) : card.kind === "clip" ? card.attachments.find(isClip) : undefined);
    if (att && elRef.current) onAttachment(card.id, att.id, elRef.current.getBoundingClientRect());
    else onOpen(card, additive);
  }, [ws, onOpen, onAttachment, linking, card, drag]);

  // ----- resize (edge and corner handles) -----
  const resizeState = useRef<{ dir: HandleDir; x: number; y: number; zoom: number; start: Rect; from: Pos; last: (Omit<Rect, "h"> & { h?: number }) | null } | null>(null);
  const autoH = card.kind === "checklist";
  const onHandleDown = (dir: HandleDir) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || !pos || !elRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    ws.bringToFront(card.id);
    // Measure the real box: an auto-height card becomes fixed-height from here on.
    const start = { x: pos.x, y: pos.y, w: pos.w ?? elRef.current.offsetWidth, h: pos.h ?? elRef.current.offsetHeight };
    resizeState.current = { dir, x: e.clientX, y: e.clientY, zoom: currentZoom(), start, from: { ...pos }, last: null };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: ReactPointerEvent) => {
    const r = resizeState.current;
    if (!r) return;
    e.stopPropagation();
    const next = resizeRect(r.start, r.dir, (e.clientX - r.x) / r.zoom, (e.clientY - r.y) / r.zoom);
    // A checklist keeps its auto height: only the width changes.
    r.last = autoH ? { ...next, h: undefined } : next;
    ws.resizeCard(card.id, r.last);
  };
  const onHandleUp = (e: ReactPointerEvent) => {
    const r = resizeState.current;
    resizeState.current = null;
    if (!r) return;
    e.stopPropagation();
    if (r.last) ws.resizeCard(card.id, r.last, { undoable: true, from: r.from });
  };

  if (!pos) return null;
  const kind = card.kind ?? "card";
  const staged = hasStage(card);
  const fixed = !autoH && pos.h !== undefined;
  const style: CSSProperties = { left: pos.x, top: pos.y, width: pos.w ?? CARD_W, height: autoH ? undefined : pos.h, zIndex: z };
  const open = openQuestions(card.items);
  const doneCount = (card.items ?? []).filter((i) => i.done).length;
  const ghost = !!card.ghost;
  const head = kind === "artifact" ? (
    <ArtifactHead card={card} />
  ) : staged ? (
    <div className="card-head">
      <button
        type="button"
        className="stage-dot-btn"
        aria-label={`Stage: ${STAGE_LABEL[card.stage]}. Change stage`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          onMenu(card.id, r.left, r.bottom + 4, true);
        }}
      >
        <span className={`dot dot-${card.stage}`} aria-hidden="true" />
      </button>
      <span className="stage-name">{STAGE_LABEL[card.stage]}</span>
      {card.stage === "built" && <span className="built-check" aria-hidden="true"><IconCheck /></span>}
      {card.role === "tech" && <span className="tech-chip">{TECH_TITLE}</span>}
      {card.role === "decisions" && <span className="tech-chip">{DECISIONS_TITLE}</span>}
      {branchGroup(card) && <span className="fork-badge" title="Part of a fork — open the card to compare">⑂</span>}
      <button
        type="button"
        className="card-menu-btn card-prompt-btn"
        aria-label={`Build a prompt from ${card.title}`}
        title="Build a prompt from this card"
        onClick={(e) => {
          e.stopPropagation();
          onPrompt(card.id);
        }}
      >
        <IconSparkle />
      </button>
    </div>
  ) : kind === "checklist" ? (
    <div className="card-head">
      <IconChecklist />
      <span className="stage-name">Checklist{card.items?.length ? ` · ${doneCount}/${card.items.length}` : ""}</span>
      {open > 0 && (
        <button
          type="button"
          className="q-badge"
          title="Answer with Claude"
          aria-label={`${open} unanswered question${open === 1 ? "" : "s"}: answer with Claude`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            ws.startChecklistGrill(card.id);
          }}
        >
          ? {open}
        </button>
      )}
    </div>
  ) : null;
  const media =
    kind === "artifact" && !ghost ? (
      <ArtifactCardBody card={card} slug={active} onChip={artifact.chip} onOpen={artifact.open} onSettings={artifact.settings} />
    ) : kind === "image" ? (
      <ImageBody image={card.attachments.find(isImage)} slug={active} title={card.title} />
    ) : kind === "clip" ? (
      <ClipBody clip={card.attachments.find(isClip)} slug={active} title={card.title} />
    ) : null;
  const content = (
    <>
      <h3>{card.title}</h3>
      {card.attachments.length > 0 && <CardAttachments cardId={card.id} attachments={card.attachments} slug={active} onOpen={onAttachment} />}
      {kind === "checklist" && (
        <ChecklistBody
          card={card}
          onItems={(items) => void ws.updateCard(card.id, { items })}
          onDelete={(ids) => void ws.deleteChecklistItems(card.id, ids)}
          titleOf={ws.titleOf}
        />
      )}
      {bodyHtml && <ScrollArea className="card-body md" dangerouslySetInnerHTML={{ __html: bodyHtml }} />}
    </>
  );
  const tagRow = card.tags.length > 0 && <div className="tags">{card.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>;
  const ghostActions = ghost && (
    <div className="ghost-actions">
      <button type="button" className="btn primary" title={card.merged_from?.length ? `Keep; the ${card.merged_from.length} original cards move to Trash` : undefined} onClick={(e) => { e.stopPropagation(); void ws.keepGhostCard(card.id); }}>Keep</button>
      <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); void ws.deleteCard(card.id); }}>Dismiss</button>
    </div>
  );
  return (
    <article
      ref={elRef}
      data-id={card.id}
      data-kind={kind}
      className={
        `card kind-${kind}` +
        (staged ? ` stage-${card.stage}` : "") +
        (card.role === "tech" ? " role-tech" : "") +
        (card.ghost ? " ghost" : "") +
        (isLinkSource ? " link-source" : "") +
        (linking ? " linkable" : "") +
        (selected ? " selected" : "") +
        (fixed ? " fixed-size" : "") +
        (pos.pinned ? " pinned" : "")
      }
      style={style}
      onDoubleClick={kind === "artifact" && !ghost ? () => artifact.open(card.id) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {ghost && (
        <div className="ghost-label"><span className="dusk-pill"><IconSparkle /> Claude suggests</span></div>
      )}
      {proposed && !ghost && (
        <DuskStrip seed={card.id} className="proposal-strip" onOpen={() => onProposal(card.id)}>
          <button type="button" className="dusk-pill" title="See what Claude suggests changing, then keep or dismiss it">
            <IconSparkle /> Claude suggests changes <span className="dusk-pill-cta">Review</span>
          </button>
        </DuskStrip>
      )}
      {!ghost ? (
        <>
          {head}
          {media ?? content}
          {tagRow}
        </>
      ) : media ? (
        <>
          {head}
          {media}
          <div className="ghost-panel ghost-strip">
            {kind === "image" && card.title && <h3>{card.title}</h3>}
            {tagRow}
            {ghostActions}
          </div>
        </>
      ) : (
        <div className="ghost-panel">
          {head}
          {content}
          {tagRow}
          {ghostActions}
        </div>
      )}
      {pos.pinned && (
        <button type="button" className="pin-badge" title="Position pinned. Click to unpin" aria-label="Unpin position" onClick={(e) => { e.stopPropagation(); drag.unpin(card.id); }}>
          <IconPin />
        </button>
      )}
      {!linking &&
        (autoH ? (["e", "w"] as HandleDir[]) : HANDLES).map((d) => (
          <div
            key={d}
            className={`rh rh-${d}`}
            aria-hidden="true"
            onPointerDown={onHandleDown(d)}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          />
        ))}
    </article>
  );
});

/**
 * "N suggestions": every pending Claude suggestion in this project (ghost cards + edit proposals).
 * The popover lists them (click focuses the card) with Keep all / Dismiss all, each one undo step;
 * more than five asks first.
 */
