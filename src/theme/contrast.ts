import { contrast, hexToRgb, over } from "./color";
import { SCROLL_THUMB_ALPHA, SCROLL_TRACK_ALPHA, type Theme } from "./types";

export interface ContrastCheck {
  label: string;
  ratio: number;
  min: number;
  pass: boolean;
}

const WHITE = hexToRgb("#ffffff");

/**
 * Text contrast checks against the surfaces text actually sits on.
 * Worst case for a glass panel is the theme's fallback color under the glass.
 * Card text sits on near-white cards, so it is checked against white too.
 */
export function checkTheme(t: Theme): ContrastCheck[] {
  const bg = hexToRgb(t.ui.fallbackBg);
  const glass = over(WHITE, bg, t.ui.glass);
  const cloudCard = over(WHITE, bg, 0.3);
  const track = over(hexToRgb(t.ui.ink), glass, SCROLL_TRACK_ALPHA);
  const thumb = over(hexToRgb(t.ui.ink), track, SCROLL_THUMB_ALPHA);
  const rows: [string, string | number[], number[], number][] = [
    ["ink on glass", t.ui.ink, glass, 4.5],
    ["body on glass", t.ui.body, glass, 4.5],
    ["muted on glass", t.ui.muted, glass, 4.5],
    ["accent on glass", t.ui.accent, glass, 4.5],
    ["ghost text on white", t.ui.ghostText, WHITE, 4.5],
    ["ink on cloud card", t.ui.ink, cloudCard, 4.5],
    ["body on cloud card", t.ui.body, cloudCard, 4.5],
    // Card menu button, resize grip, "+ More" helper text sit on cards and dialogs.
    ["muted on cloud card", t.ui.muted, cloudCard, 4.5],
    ["accent on cloud card (links)", t.ui.accent, cloudCard, 4.5],
    ["white on accent (buttons)", "#ffffff", hexToRgb(t.ui.accent), 4.5],
    // Non-text UI component (WCAG 1.4.11): the scrollbar thumb against its track on glass.
    ["scrollbar thumb on track (UI)", thumb, track, 3],
  ];
  return rows.map(([label, fg, surface, min]) => {
    const ratio = contrast(typeof fg === "string" ? hexToRgb(fg) : (fg as [number, number, number]), surface as [number, number, number]);
    return { label, ratio, min, pass: ratio >= min };
  });
}
