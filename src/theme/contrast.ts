import { contrast, hexToRgb, over } from "./color";
import type { Theme } from "./types";

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
  const rows: [string, string, number[], number][] = [
    ["ink on glass", t.ui.ink, glass, 4.5],
    ["body on glass", t.ui.body, glass, 4.5],
    ["muted on glass", t.ui.muted, glass, 4.5],
    ["accent on glass", t.ui.accent, glass, 4.5],
    ["ghost text on white", t.ui.ghostText, WHITE, 4.5],
    ["ink on cloud card", t.ui.ink, cloudCard, 4.5],
    ["body on cloud card", t.ui.body, cloudCard, 4.5],
    ["white on accent (buttons)", "#ffffff", hexToRgb(t.ui.accent), 4.5],
  ];
  return rows.map(([label, fg, surface, min]) => {
    const ratio = contrast(hexToRgb(fg), surface as [number, number, number]);
    return { label, ratio, min, pass: ratio >= min };
  });
}
