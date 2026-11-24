import { useEffect, useMemo, useRef, useState } from "react";
import type { OrganizeLayout, OrganizeOp, OrganizePlanData, ProjectData } from "../api";
import type { Backend } from "../api/claude";
import type { ChatMessage } from "../state/useClaudeChat";
import { simulateOrganize, folderName, type OrganizeSim, type Workspace } from "../state/useWorkspace";
import { folderRect, type Rect } from "./cardGeometry";
import { DuskStrip, useDuskGlass } from "./DuskGlass";
import { IconFolder, IconSparkle } from "./Icons";

const LAYOUT_LABEL: Record<OrganizeLayout, string> = { grid: "a grid", "cluster-by-tag": "clusters by tag", "flow-by-links": "a flow by links", "stage-columns": "stage columns" };
/** Preview ids of the folders and frames a plan would make. */
const TMP = "tmp-";
const tmpId = (t: string) => `${TMP}${t}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The plan run on the project as it is now, with preview ids for new items. */
function usePlanSim(data: ProjectData | null, plan: OrganizePlanData | undefined, checked: boolean[] | undefined): OrganizeSim | null {
  return useMemo(
    () => (data && plan && checked && plan.slug === data.slug ? simulateOrganize({ canvases: data.canvases, folders: data.folders }, data.cards, plan, checked, tmpId) : null),
    [data, plan, checked],
  );
}

/** Ids (existing, or tmp- for new) an op touches: what hovering its row highlights. */
function opItems(op: OrganizeOp, plan: OrganizePlanData): string[] {
  const ref = (id: string) => (plan.ops.some((o) => (o.op === "create_folder" || o.op === "create_frame") && o.tempId === id) ? tmpId(id) : id);
  switch (op.op) {
    case "create_folder":
    case "create_frame":
      return [tmpId(op.tempId)];
    case "rename":
    case "retag":
      return [ref(op.id)];
    case "move":
      return [...op.ids.map(ref), ...(op.to ? [ref(op.to)] : [])];
    case "arrange":
      return op.ids;
    case "place":
      return Object.keys(op.positions);
  }
}

/** A one-line, human description of an op. */
function describe(op: OrganizePlanData["ops"][number], plan: OrganizePlanData, data: ProjectData | null): { text: string; detail?: string } {
  const made = (t: string) => plan.ops.find((o): o is Extract<OrganizeOp, { op: "create_folder" | "create_frame" }> => (o.op === "create_folder" || o.op === "create_frame") && o.tempId === t)?.title;
  const folder = (ref: string | null) => (ref == null ? data?.meta.name ?? "the project" : made(ref) ?? plan.titles[ref] ?? folderName(data?.folders.find((f) => f.id === ref)));
  const title = (id: string) => made(id) ?? plan.titles[id] ?? data?.cards.find((c) => c.id === id)?.title ?? id;
  const isCard = (id: string) => !!data?.cards.some((c) => c.id === id);
  switch (op.op) {
    case "create_folder": {
      const n = plan.ops.reduce((s, o) => s + (o.op === "move" && o.to === op.tempId ? o.ids.filter(isCard).length : 0), 0);
      return { text: `New folder ${op.title}: ${plural(n, "card")}`, detail: op.parent ? `inside ${folder(op.parent)}` : undefined };
    }
    case "rename":
      return { text: `Rename ${title(op.id)} to ${op.title}` };
    case "move": {
      const cards = op.ids.filter(isCard).length;
      const folders = op.ids.length - cards;
      const what = [cards && plural(cards, "card"), folders && plural(folders, "folder")].filter(Boolean).join(" and ");
      return { text: `Move ${what} to ${folder(op.to)}`, detail: op.ids.map(title).join(", ") };
    }
    case "create_frame":
      return { text: `New frame ${op.title} in ${folder(op.folder)}` };
    case "arrange":
      return { text: `Re-layout ${folder(op.folder)} as ${LAYOUT_LABEL[op.layout]}`, detail: plural(op.ids.length, "card") };
    case "place": {
      const ids = Object.keys(op.positions);
      return { text: `Lay out ${plural(ids.length, "card")} in their frames`, detail: ids.map(title).join(", ") };
    }
    case "retag":
      return { text: `Tags on ${title(op.id)}: ${[...op.add.map((t) => `+${t}`), ...op.remove.map((t) => `−${t}`)].join(" ")}` };
  }
}

/**
 * The plan in chat: rationale, one checkbox per op, Apply / Discard / Redo and a reply box that
 * revises the same plan. While open (the newest plan of the thread), the canvas previews it.
 */
export function OrganizePlanCard({
  message,
  ws,
  busy,
  onChange,
  onRedo,
  onRevise,
  onFinish,
}: {
  message: ChatMessage;
  ws: Workspace;
  busy: boolean;
  onChange: (patch: Partial<NonNullable<ChatMessage["organize"]>>) => void;
  onRedo: (backend: Backend) => void;
  onRevise: (text: string) => void;
  /** A partial plan: place its unplaced cards (on Claude, or locally again). Never runs by itself. */
  onFinish: (backend: Backend) => void;
}) {
  const org = message.organize!;
  const { plan, status, checked } = org;
  const open = status === "open";
  const [hover, setHover] = useState<number | null>(null);
  const [reply, setReply] = useState("");
  const [applying, setApplying] = useState(false);
  const sim = usePlanSim(ws.data, plan, checked);
  const here = ws.active === plan.slug;

  // The canvas previews the open plan; closing it (or leaving) clears the preview.
  const { setOrganizePreview } = ws;
  useEffect(() => {
    if (!open || !here) return;
    setOrganizePreview({ plan, checked, hover });
  }, [open, here, plan, checked, hover, setOrganizePreview]);
  useEffect(() => {
    if (!open || !here) return;
    return () => setOrganizePreview((p) => (p?.plan === plan ? null : p));
  }, [open, here, plan, setOrganizePreview]);

  const effective = sim?.effective ?? plan.ops.map(() => false);
  const nOn = effective.filter(Boolean).length;
  const madeBy = message.backend ?? "claude";

  if (!open) {
    const what = status === "applied" ? "Applied" : status === "discarded" ? "Discarded" : "Replaced by a newer plan";
    return (
      <div className="organize-card closed" aria-label="Organize plan">
        <span className="organize-closed">
          <IconSparkle /> Plan for {plan.scopeName} · {plural(plan.ops.length, "change")} · {what}
        </span>
      </div>
    );
  }

  const apply = async () => {
    setApplying(true);
    const ok = await ws.applyOrganize(plan, checked);
    setApplying(false);
    if (ok) onChange({ status: "applied" });
  };

  return (
    <div className="organize-card" aria-label="Organize plan">
      <DuskStrip seed={message.id} className="organize-head">
        <span className="dusk-pill">
          <IconSparkle /> Claude's plan for {plan.scopeName}
        </span>
      </DuskStrip>
      {plan.rationale && <p className="organize-why">{plan.rationale}</p>}
      <ul className="organize-ops" onMouseLeave={() => setHover(null)}>
        {plan.ops.map((op, i) => {
          const d = describe(op, plan, ws.data);
          const skipped = checked[i] && !effective[i];
          return (
            <li key={i} className={"organize-op" + (hover === i ? " hot" : "") + (skipped ? " skipped" : "")} onMouseEnter={() => setHover(i)} title={d.detail}>
              <label>
                <input
                  type="checkbox"
                  checked={checked[i]}
                  disabled={busy || applying}
                  onChange={(e) => onChange({ checked: checked.map((c, j) => (j === i ? e.target.checked : c)) })}
                />
                <span className="organize-op-text">{d.text}</span>
                {skipped && <span className="organize-op-note">needs a folder that is off</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {plan.kept.length > 0 && <p className="organize-kept">Kept in place (pinned): {plan.kept.map((k) => k.title).join(", ")}</p>}
      {plan.partial && !!plan.unplaced?.length && (
        <div className="organize-partial" role="note">
          <p className="organize-kept">
            Not placed yet ({plan.unplaced.length}): {plan.unplaced.map((u) => u.title).join(", ")}. Applying lays them out below the frames.
          </p>
          <div className="organize-actions">
            <button type="button" className="chip" disabled={busy || applying} title="Ask Claude to place only these cards into the plan's frames" onClick={() => onFinish("claude")}>
              Finish with Claude
            </button>
            <button type="button" className="chip" disabled={busy || applying} title="Try the local model again for only these cards" onClick={() => onFinish("local")}>
              Retry rest locally
            </button>
          </div>
        </div>
      )}
      {!here && <p className="organize-kept">This plan is for another project. Open it to preview and apply.</p>}
      <div className="organize-actions">
        <button type="button" className="btn primary" disabled={!here || busy || applying || nOn === 0} onClick={() => void apply()}>
          Apply{nOn !== plan.ops.length ? ` ${nOn}` : ""}
        </button>
        <button type="button" className="btn" disabled={applying} onClick={() => onChange({ status: "discarded" })}>
          Discard
        </button>
        <div className="side-spacer" />
        <button type="button" className="chip" disabled={busy || applying} title="Make this plan again with Claude" onClick={() => onRedo("claude")}>
          Redo with Claude
        </button>
        {madeBy === "claude" && (
          <button type="button" className="chip" disabled={busy || applying} title="Make this plan again on the local model" onClick={() => onRedo("local")}>
            Redo locally
          </button>
        )}
      </div>
      <form
        className="organize-reply"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reply.trim() || busy) return;
          onRevise(reply.trim());
          setReply("");
        }}
      >
        <input className="name-input" value={reply} placeholder="Ask for changes, e.g. keep Art as it is" disabled={busy || applying} onChange={(e) => setReply(e.target.value)} aria-label="Ask Claude to change the plan" />
        <button type="submit" className="chip" disabled={busy || applying || !reply.trim()}>
          Revise
        </button>
      </form>
    </div>
  );
}

/** The text of a revision turn: the previous plan travels with it, so any backend can continue it. */
export function reviseText(plan: OrganizePlanData, ask: string): string {
  const prev = JSON.stringify({ rationale: plan.rationale, ops: plan.ops });
  return `/organize revise (scope: ${plan.scope}): ${ask}\n\n[Previous plan]\n${prev.length > 8000 ? `${prev.slice(0, 8000)}…` : prev}`;
}

function GhostFolder({ id, title, pos, cards, hot, dim }: { id: string; title: string; pos: Rect; cards: number; hot: boolean; dim: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDuskGlass(ref, "card", id);
  return (
    <div ref={ref} className={"organize-ghost-folder" + (hot ? " hot" : "") + (dim ? " dim" : "")} style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }}>
      <span className="dusk-pill">
        <IconFolder /> New folder
      </span>
      <div className="organize-ghost-panel">
        <strong>{title}</strong>
        <span>{plural(cards, "card")}</span>
      </div>
    </div>
  );
}

/**
 * The open plan on the canvas (inside the world transform): ghost folders where they'd be made,
 * a dusk strip on every card that moves or is re-laid out, faint outlines at re-layout targets.
 * Hovering an op in chat highlights only its items.
 */
export function OrganizePreviewLayer({ ws, rectOf }: { ws: Workspace; rectOf: (id: string) => Rect | undefined }) {
  const p = ws.organizePreview;
  const data = ws.data;
  const sim = usePlanSim(data, p?.plan, p?.checked);
  if (!p || !data || !sim) return null;
  const key = ws.folder ?? "";
  const now = data.canvases[key];
  const next = sim.structure.canvases[key];
  if (!now || !next) return null;
  const hot = p.hover != null && p.plan.ops[p.hover] ? new Set(opItems(p.plan.ops[p.hover], p.plan)) : null;
  const cls = (id: string) => (hot ? (hot.has(id) ? " hot" : " dim") : "");
  const folderTitle = (id: string) => (id === "" ? data.meta.name : folderName(sim.structure.folders.find((f) => f.id === id)));
  const strips: { id: string; r: Rect; text: string }[] = [];
  const outlines: { id: string; r: Rect }[] = [];
  for (const id of [...Object.keys(now.cards), ...Object.keys(now.folders ?? {})]) {
    const r = rectOf(id);
    if (!r) continue;
    const to = sim.moved[id];
    if (to !== undefined && to !== key) strips.push({ id, r, text: `Claude: move to ${folderTitle(to)}` });
    else if (sim.arranged.has(id) && next.cards[id]) {
      strips.push({ id, r, text: "Claude: re-layout" });
      outlines.push({ id, r: { ...r, x: next.cards[id].x, y: next.cards[id].y } });
    } else if (sim.tags.some((t) => t.id === id)) strips.push({ id, r, text: "Claude: retag" });
  }
  return (
    <div className="organize-preview" aria-hidden="true">
      {outlines.map((o) => (
        <div key={`o-${o.id}`} className={"organize-outline" + cls(o.id)} style={{ left: o.r.x, top: o.r.y, width: o.r.w, height: o.r.h }} />
      ))}
      {Object.entries(next.frames)
        .filter(([id]) => id.startsWith(TMP))
        .map(([id, f]) => (
          <div key={id} className={"organize-ghost-frame" + cls(id)} style={{ left: f.x, top: f.y, width: f.w, height: f.h }}>
            <span className="dusk-pill">
              <IconSparkle /> {f.title}
            </span>
          </div>
        ))}
      {Object.entries(next.folders ?? {})
        .filter(([id]) => id.startsWith(TMP))
        .map(([id, pos]) => (
          <GhostFolder
            key={id}
            id={id}
            title={folderTitle(id)}
            pos={folderRect(pos)}
            cards={Object.keys(sim.structure.canvases[id]?.cards ?? {}).length}
            hot={!!hot?.has(id)}
            dim={!!hot && !hot.has(id)}
          />
        ))}
      {strips.map((s) => (
        <div key={`s-${s.id}`} className={"organize-strip-at" + cls(s.id)} style={{ left: s.r.x, top: s.r.y - 30, width: s.r.w }}>
          <DuskStrip seed={s.id} className="organize-strip">
            <span className="dusk-pill">
              <IconSparkle /> {s.text}
            </span>
          </DuskStrip>
        </div>
      ))}
    </div>
  );
}

/** "Tidy this folder?": a dusk pill at the canvas top. Never runs anything by itself. */
export function TidyNudge({ onTidy, onClose }: { onTidy: () => void; onClose: () => void }) {
  return (
    <div className="tidy-nudge" data-wheel-boundary="">
      <DuskStrip seed="tidy" className="tidy-nudge-strip">
        <span className="dusk-pill">
          <IconSparkle /> Tidy this folder?
          <button type="button" className="dusk-pill-cta" onClick={onTidy}>
            Tidy
          </button>
          <button type="button" className="tidy-x" aria-label="Don't suggest tidying this folder again" title="Don't suggest this again for this folder" onClick={onClose}>
            ×
          </button>
        </span>
      </DuskStrip>
    </div>
  );
}
