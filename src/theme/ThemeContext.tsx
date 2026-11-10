import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { applyTheme } from "./applyTheme";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "./presets";
import type { Theme } from "./types";

interface ThemeCtx {
  themes: Theme[];
  theme: Theme;
  setThemeId: (id: string) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);
const KEY = "dreamer.theme";

function loadId(): string {
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/** Apply the saved theme before first paint so there is no flash of the default colors. */
export function bootTheme() {
  const t = BUILTIN_THEMES.find((x) => x.id === loadId()) ?? BUILTIN_THEMES[0];
  applyTheme(t);
}

/**
 * The chosen theme id lives in workspace.json (source of truth). localStorage is only a cache so the
 * right colors are applied synchronously before first paint. User themes + per-project override: step 8.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const themes = BUILTIN_THEMES;
  const [id, setId] = useState(loadId);
  const theme = useMemo(() => themes.find((t) => t.id === id) ?? themes[0], [themes, id]);

  useEffect(() => applyTheme(theme), [theme]);

  // Sync with workspace.json: on start, and when the file changes on disk (git pull, hand edit).
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | undefined;
    const pull = () =>
      api
        .getSettings()
        .then((s) => {
          if (disposed || !themes.some((t) => t.id === s.theme)) return;
          setId(s.theme);
          try {
            localStorage.setItem(KEY, s.theme);
          } catch {
            /* cache only */
          }
        })
        .catch(() => {});
    void pull();
    api
      .onChange((events) => {
        if (events.some((e) => e.scope === "settings")) void pull();
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [themes]);

  const setThemeId = useCallback((next: string) => {
    setId(next);
    api.updateSettings({ theme: next }).catch(() => {});
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage can be unavailable; the choice just won't persist */
    }
  }, []);

  return <Ctx.Provider value={{ themes, theme, setThemeId }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}
