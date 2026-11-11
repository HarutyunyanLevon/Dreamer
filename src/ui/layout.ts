/**
 * Panel geometry, mirrored from the CSS tokens in styles.css (--gap, --side-w, --chat-w, --tab-w).
 * The CSS is the source of truth for layout; JS only needs these to centre the camera on a card
 * inside the free canvas area (search focus).
 */
export const GAP = 16;
export const SIDE_W = 224;
export const CHAT_W = 340;
export const TAB_W = 30;

/** Shown/hidden state of the side panels, written to <html data-left/data-right> by usePanels. */
const shown = (side: "left" | "right") => document.documentElement.dataset[side] !== "hidden";

/** Left and right edges (in window px) of the free canvas area between the panels. */
export function freeArea(width: number): { left: number; right: number } {
  const l = shown("left") ? GAP * 2 + SIDE_W : TAB_W + GAP;
  const r = shown("right") ? GAP * 2 + CHAT_W : TAB_W + GAP;
  return { left: l, right: width - r };
}
