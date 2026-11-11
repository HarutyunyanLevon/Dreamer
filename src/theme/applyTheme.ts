import { rgba } from "./color";
import { SCROLL_THUMB_ALPHA, SCROLL_THUMB_HOVER_ALPHA, SCROLL_TRACK_ALPHA, STAGES, type Theme } from "./types";

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
    v[`--stage-${id}`] = t.stages[id];
    v[`--stage-${id}-glow`] = rgba(t.stages[id], 0.6);
  }
  return v;
}

/** Write a theme's tokens to CSS variables on :root. */
export function applyTheme(t: Theme, root: HTMLElement = document.documentElement) {
  for (const [k, val] of Object.entries(themeVars(t))) root.style.setProperty(k, val);
}
