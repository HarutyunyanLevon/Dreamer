import { type Canvas, type Card, type OrganizeLayout, type OrganizePlanData, type ProjectData } from "../../api";
import { CARD_H, CARD_W } from "../../components/cardGeometry";

export type Layout = Pick<Canvas, "cards" | "frames">;
export const layoutOf = (c: Canvas): Layout => ({ cards: c.cards, frames: c.frames ?? {} });
export const withFrames = (d: ProjectData): ProjectData => ({ ...d, canvas: { ...d.canvas, frames: d.canvas.frames ?? {} } });

const STAGE_ORDER = ["mist", "reverie", "lucid", "dream", "built"];

/** Target positions for an arrange op: groups side by side, each a grid (or one column). */
function layoutCards(list: string[], c: Canvas, byId: Map<string, Card>, layout: OrganizeLayout): Record<string, { x: number; y: number }> {
  const ps = list.map((id) => c.cards[id]);
  const ox = Math.min(...ps.map((p) => p.x));
  const oy = Math.min(...ps.map((p) => p.y));
  const cw = Math.max(...ps.map((p) => p.w ?? CARD_W)) + 40;
  const ch = Math.max(...ps.map((p) => p.h ?? CARD_H + 60)) + 40;
  // Reading order of where they sit now, so a re-layout keeps them roughly in place.
  const sorted = [...list].sort((a, b) => Math.round(c.cards[a].y / 100) - Math.round(c.cards[b].y / 100) || c.cards[a].x - c.cards[b].x);
  const square = (n: number) => Math.max(1, Math.ceil(Math.sqrt(n)));
  let groups: string[][];
  let colsOf: (n: number) => number = () => 1;
  if (layout === "grid") {
    groups = [sorted];
    colsOf = square;
  } else if (layout === "cluster-by-tag") {
    const freq = new Map<string, number>();
    for (const id of sorted) for (const t of byId.get(id)?.tags ?? []) freq.set(t, (freq.get(t) ?? 0) + 1);
    const tagOf = (id: string) => [...(byId.get(id)?.tags ?? [])].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b))[0] ?? "";
    const by = new Map<string, string[]>();
    for (const id of sorted) by.set(tagOf(id), [...(by.get(tagOf(id)) ?? []), id]);
    groups = [...by.entries()].sort((a, b) => (a[0] === "" ? 1 : 0) - (b[0] === "" ? 1 : 0) || b[1].length - a[1].length).map(([, g]) => g);
    colsOf = (n) => Math.min(3, square(n));
  } else if (layout === "stage-columns") {
    groups = STAGE_ORDER.map((st) => sorted.filter((id) => byId.get(id)?.stage === st)).filter((g) => g.length);
    const rest = sorted.filter((id) => !STAGE_ORDER.includes(byId.get(id)?.stage ?? ""));
    if (rest.length) groups.push(rest);
  } else {
    // flow-by-links: a card sits one column right of the furthest card linking to it.
    const inSet = new Set(sorted);
    const depth = new Map(sorted.map((id) => [id, 0]));
    for (let pass = 0; pass < sorted.length; pass++) {
      let changed = false;
      for (const a of sorted) {
        for (const l of byId.get(a)?.links ?? []) {
          const d = depth.get(a)! + 1;
          if (inSet.has(l.to) && d < sorted.length && d > depth.get(l.to)!) {
            depth.set(l.to, d);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const max = Math.max(0, ...depth.values());
    groups = Array.from({ length: max + 1 }, (_, d) => sorted.filter((id) => depth.get(id) === d)).filter((g) => g.length);
  }
  const out: Record<string, { x: number; y: number }> = {};
  let x = ox;
  for (const g of groups) {
    const cols = colsOf(g.length);
    g.forEach((id, i) => (out[id] = { x: Math.round(x + (i % cols) * cw), y: Math.round(oy + Math.floor(i / cols) * ch) }));
    x += Math.min(cols, g.length) * cw + 80;
  }
  return out;
}

/** What an organize plan does to the canvas (pure: the canvas preview and Apply share it). */
export interface OrganizeSim {
  canvas: Canvas;
  /** Ops that take effect (checked). */
  effective: boolean[];
  /** Re-laid-out card ids. */
  arranged: Set<string>;
  /** Cards whose tags change, with their new lists. */
  tags: { id: string; tags: string[] }[];
  /** tempId -> the id it got. */
  ids: Record<string, string>;
}

/** Runs the checked ops of `plan` on `c0`. */
export function simulateOrganize(c0: Canvas, cards: Card[], plan: OrganizePlanData, checked: boolean[], idFor: (tempId: string) => string): OrganizeSim {
  let c = c0;
  const ids: Record<string, string> = {};
  const byId = new Map(cards.map((x) => [x.id, x]));
  const effective = plan.ops.map(() => false);
  const arranged = new Set<string>();
  const tagMap = new Map<string, string[]>();
  plan.ops.forEach((op, i) => {
    if (checked[i] === false) return;
    if (op.op === "rename") {
      const id = ids[op.id] ?? op.id;
      if (!c.frames[id]) return;
      c = { ...c, frames: { ...c.frames, [id]: { ...c.frames[id], title: op.title } } };
    } else if (op.op === "create_frame") {
      const id = idFor(op.tempId);
      ids[op.tempId] = id;
      const z = Math.max(-1, ...Object.values(c.frames).map((f) => f.z)) + 1;
      c = { ...c, frames: { ...c.frames, [id]: { ...op.rect, title: op.title, z, ...(op.color ? { color: op.color } : {}) } } };
    } else if (op.op === "arrange") {
      const list = op.ids.filter((id) => c.cards[id] && !c.cards[id].pinned);
      if (!list.length) return;
      const pos = layoutCards(list, c, byId, op.layout);
      const next = { ...c.cards };
      for (const [id, p] of Object.entries(pos)) next[id] = { ...next[id], ...p };
      c = { ...c, cards: next };
      list.forEach((id) => arranged.add(id));
    } else if (op.op === "place") {
      // Explicit positions (the organize pipeline's own layout); pinned cards never move.
      const next = { ...c.cards };
      let n = 0;
      for (const [id, p] of Object.entries(op.positions)) {
        if (!c.cards[id] || c.cards[id].pinned) continue;
        next[id] = { ...next[id], x: p.x, y: p.y };
        arranged.add(id);
        n++;
      }
      if (!n) return;
      c = { ...c, cards: next };
    } else if (op.op === "retag") {
      const card = byId.get(op.id);
      if (!card) return;
      const cur = tagMap.get(op.id) ?? card.tags;
      tagMap.set(op.id, [...cur.filter((t) => !op.remove.includes(t)), ...op.add.filter((t) => !cur.includes(t))]);
    } else return;
    effective[i] = true;
  });
  const tags = [...tagMap].filter(([id, t]) => t.join("\n") !== (byId.get(id)?.tags ?? []).join("\n")).map(([id, t]) => ({ id, tags: t }));
  return { canvas: c, effective, arranged, tags, ids };
}

/** The plan card that's open in chat: the canvas previews it (hover = one op's items). */
