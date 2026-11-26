/**
 * Panel geometry. The CSS tokens in styles.css (--gap, --side-w, --chat-w, --tab-w) are the source
 * of truth for layout; the panel widths are user-resizable (usePanels writes --side-w / --chat-w on
 * <html> through setPanelWidth). JS reads them back to centre the camera on a card inside the free
 * canvas area (search focus).
 */
export const GAP = 16;
const TAB_W = 30;

let cache: { left: number; right: number } | null = null;

/** Current panel widths in px, read from the CSS vars (cached until setPanelWidth changes one). */
export function panelWidths(): { left: number; right: number } {
  if (!cache) {
    const cs = getComputedStyle(document.documentElement);
    cache = {
      left: parseFloat(cs.getPropertyValue("--side-w")) || 224,
      right: parseFloat(cs.getPropertyValue("--chat-w")) || 340,
    };
  }
  return cache;
}

/** Writes --side-w (left) or --chat-w (right) on <html> and refreshes the cache. */
export function setPanelWidth(side: "left" | "right", px: number) {
  document.documentElement.style.setProperty(side === "left" ? "--side-w" : "--chat-w", `${px}px`);
  cache = { ...panelWidths(), [side]: px };
}

/** Shown/hidden state of the side panels, written to <html data-left/data-right> by usePanels. */
const panelShown = (side: "left" | "right") => document.documentElement.dataset[side] !== "hidden";

/** Space a panel takes from its window edge (panel + margins, or the bookmark tab when hidden). */
export function panelInset(side: "left" | "right"): number {
  return panelShown(side) ? GAP * 2 + panelWidths()[side] : TAB_W + GAP;
}

/** Left and right edges (in window px) of the free canvas area between the panels. */
export function freeArea(width: number): { left: number; right: number } {
  return { left: panelInset("left"), right: width - panelInset("right") };
}
