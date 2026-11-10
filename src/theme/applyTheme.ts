import { rgba } from "./color";
import { STAGES, type Theme } from "./types";

/** Write a theme's tokens to CSS variables on :root. */
export function applyTheme(t: Theme, root: HTMLElement = document.documentElement) {
  const s = root.style;
  s.setProperty("--ink", t.ui.ink);
  s.setProperty("--body", t.ui.body);
  s.setProperty("--muted", t.ui.muted);
  s.setProperty("--link", t.ui.link);
  s.setProperty("--accent", t.ui.accent);
  s.setProperty("--ghost", t.ui.ghost);
  s.setProperty("--ghost-text", t.ui.ghostText);
  s.setProperty("--fallback-bg", t.ui.fallbackBg);
  s.setProperty("--glass", `rgba(255, 255, 255, ${t.ui.glass})`);
  s.setProperty("--ink-shadow", rgba(t.ui.ink, 0.16));
  s.setProperty("--accent-soft", rgba(t.ui.accent, 0.12));
  s.setProperty("--ghost-glow", rgba(t.ui.ghost, 0.38));
  for (const id of STAGES) {
    s.setProperty(`--stage-${id}`, t.stages[id]);
    s.setProperty(`--stage-${id}-glow`, rgba(t.stages[id], 0.6));
  }
}
