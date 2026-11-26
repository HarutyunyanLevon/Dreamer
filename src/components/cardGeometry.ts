import type { Pos } from "../api";

/** Default card width; height is automatic until the user resizes the card. */
export const CARD_W = 236;
/** Height estimate before a card has been measured (culling, link endpoints). */
export const CARD_H = 150;
/** Mirrors MIN_CARD_W / MIN_CARD_H in src-tauri/src/model.rs. */
export const MIN_W = 160;
export const MIN_H = 90;
export const MAX_SIDE = 4000;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A card's box in world units. `measured` is the rendered height of an auto-height card. */
export function cardRect(p: Pos, measured?: number): Rect {
  return { x: p.x, y: p.y, w: p.w ?? CARD_W, h: p.h ?? measured ?? CARD_H };
}

export type HandleDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const HANDLES: HandleDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** New box after dragging handle `dir` by (dx, dy) world units from `start`; opposite edges stay put. */
export function resizeRect(start: Rect, dir: HandleDir, dx: number, dy: number): Rect {
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = start.w + dx;
  if (dir.includes("s")) h = start.h + dy;
  if (dir.includes("w")) w = start.w - dx;
  if (dir.includes("n")) h = start.h - dy;
  w = Math.min(MAX_SIDE, Math.max(MIN_W, w));
  h = Math.min(MAX_SIDE, Math.max(MIN_H, h));
  if (dir.includes("w")) x = start.x + start.w - w;
  if (dir.includes("n")) y = start.y + start.h - h;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

const contains = (outer: Rect, inner: Rect) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;

/**
 * Display stacking for the rendered cards: persisted `z` order (ties by array order), except that a
 * card completely covered by a card above it is lifted to the front so it can't vanish, unless the
 * user explicitly sent it to the back. Display-only: nothing here is saved.
 * O(n^2) over the *rendered* (viewport-culled) cards only.
 */
export function displayStack(ids: string[], rectOf: (id: string) => Rect | undefined, posOf: (id: string) => Pos | undefined): Map<string, number> {
  const items = ids
    .map((id, i) => ({ id, i, p: posOf(id), r: rectOf(id) }))
    .filter((it): it is { id: string; i: number; p: Pos; r: Rect } => !!it.p && !!it.r)
    .sort((a, b) => (a.p.z ?? 0) - (b.p.z ?? 0) || a.i - b.i);
  const rank = new Map<string, number>();
  items.forEach((it, k) => rank.set(it.id, k + 1));
  let lifted = items.length + 1;
  for (let k = 0; k < items.length; k++) {
    const a = items[k];
    if (a.p.back) continue;
    for (let j = k + 1; j < items.length; j++) {
      if (contains(items[j].r, a.r)) {
        rank.set(a.id, lifted++);
        break;
      }
    }
  }
  return rank;
}
