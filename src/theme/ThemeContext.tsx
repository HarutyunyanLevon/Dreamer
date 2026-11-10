import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
 * Step 2: built-in themes only, choice kept in localStorage.
 * Step 3+ moves the choice to workspace.json and adds user themes + per-project override.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const themes = BUILTIN_THEMES;
  const [id, setId] = useState(loadId);
  const theme = useMemo(() => themes.find((t) => t.id === id) ?? themes[0], [themes, id]);

  useEffect(() => applyTheme(theme), [theme]);

  const setThemeId = useCallback((next: string) => {
    setId(next);
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
