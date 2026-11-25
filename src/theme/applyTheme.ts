import { hexToRgb, over, rgba, stageBorder } from "./color";
import { BUILT_COLOR, SCROLL_THUMB_ALPHA, SCROLL_THUMB_HOVER_ALPHA, SCROLL_TRACK_ALPHA, STAGES, STAGE_CARD_ALPHA, type StageId, type Theme } from "./types";

export const stageColor = (t: Theme, id: StageId) => t.stages[id] ?? BUILT_COLOR;

/** A theme's tokens as CSS custom properties (used for :root and for scoped previews). */
export function themeVars(t: Theme): Record<string, string> {
  const v: Record<string, string> = {
    "--ink": t.ui.ink,
    "--body": t.ui.body,
    "--muted": t.ui.muted,
    "--link": t.ui.link,
    "--accent": t.ui.accent,
    "--ghost": t.ui.ghost,
    "--ghost-text": t.ui.ghostText,
    "--fallback-bg": t.ui.fallbackBg,
    "--glass": `rgba(255, 255, 255, ${t.ui.glass})`,
    "--ink-shadow": rgba(t.ui.ink, 0.16),
    "--accent-soft": rgba(t.ui.accent, 0.12),
    "--ghost-glow": rgba(t.ui.ghost, 0.38),
    "--scroll-thumb": rgba(t.ui.ink, SCROLL_THUMB_ALPHA),
    "--scroll-thumb-hover": rgba(t.ui.ink, SCROLL_THUMB_HOVER_ALPHA),
    "--scroll-track": rgba(t.ui.ink, SCROLL_TRACK_ALPHA),
  };
  for (const id of STAGES) {
    v[`--stage-${id}`] = stageColor(t, id);
    v[`--stage-${id}-glow`] = rgba(stageColor(t, id), 0.6);
    v[`--stage-${id}-border`] = stageBorderFor(t, id);
  }
  return v;
}

/** The stage's card border colour, readable (3:1) against that stage's own card surface. */
export function stageBorderFor(t: Theme, id: (typeof STAGES)[number]): string {
  return stageBorder(stageColor(t, id), t.ui.ink, cardSurface(t, id));
}

/** A stage's card background as it looks over the theme's fallback colour (worst case). */
export function cardSurface(t: Theme, id: (typeof STAGES)[number]) {
  return over([255, 255, 255], hexToRgb(t.ui.fallbackBg), STAGE_CARD_ALPHA[id]);
}

/** Write a theme's tokens to CSS variables on :root. */
export function applyTheme(t: Theme, root: HTMLElement = document.documentElement) {
  for (const [k, val] of Object.entries(themeVars(t))) root.style.setProperty(k, val);
}
