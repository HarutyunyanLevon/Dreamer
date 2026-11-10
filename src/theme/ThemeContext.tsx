import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import { applyTheme } from "./applyTheme";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "./presets";
import type { Theme } from "./types";

interface ThemeCtx {
  themes: Theme[];
  theme: Theme;
  /** The user's global default (ignoring any per-project override currently in effect). */
  globalThemeId: string;
  setThemeId: (id: string) => void;
  saveCustomTheme: (theme: Theme) => Promise<void>;
  deleteCustomTheme: (id: string) => Promise<void>;
  /** While set, overrides `theme` everywhere (including the shader) for live editing — never persisted. */
  setPreviewTheme: (theme: Theme | null) => void;
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

function isTheme(v: unknown): v is Theme {
  const t = v as Partial<Theme> | null;
  return !!t && typeof t.id === "string" && typeof t.name === "string" && !!t.shader && !!t.ui && !!t.stages;
}

/**
 * The chosen theme id lives in workspace.json (source of truth); localStorage is only a cache so
 * the right colors are applied synchronously before first paint. `projectTheme`, when set, is the
 * active project's override (project.json's `theme`) and wins over the global default.
 */
export function ThemeProvider({ children, projectTheme }: { children: ReactNode; projectTheme?: string | null }) {
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const themes = useMemo(() => [...BUILTIN_THEMES, ...customThemes], [customThemes]);
  const [id, setId] = useState(loadId);
  const [preview, setPreview] = useState<Theme | null>(null);
  const effectiveId = projectTheme || id;
  const resolved = useMemo(() => themes.find((t) => t.id === effectiveId) ?? themes.find((t) => t.id === id) ?? themes[0], [themes, effectiveId, id]);
  const theme = preview ?? resolved;

  useEffect(() => applyTheme(theme), [theme]);

  // Sync with workspace.json: on start, and when the file changes on disk (git pull, hand edit).
  useEffect(() => {
    let disposed = false;
    const pull = () =>
      api
        .getSettings()
        .then((s) => {
          if (disposed) return;
          setId(s.theme);
          try {
            localStorage.setItem(KEY, s.theme);
          } catch {
            /* cache only */
          }
        })
        .catch(() => {});
    void pull();
    let unsub: (() => void) | undefined;
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
  }, []);

  // Custom themes live in themes/*.json; reload when that scope changes.
  useEffect(() => {
    let disposed = false;
    const pull = () =>
      api
        .listCustomThemes()
        .then((list) => !disposed && setCustomThemes(list.filter(isTheme)))
        .catch(() => {});
    void pull();
    let unsub: (() => void) | undefined;
    api
      .onChange((events) => {
        if (events.some((e) => e.scope === "themes")) void pull();
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      unsub?.();
    };
  }, []);

  const setThemeId = useCallback((next: string) => {
    setId(next);
    api.updateSettings({ theme: next }).catch(() => {});
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage can be unavailable; the choice just won't persist */
    }
  }, []);

  const saveCustomTheme = useCallback(async (t: Theme) => {
    await api.saveCustomTheme(t.id, t);
    setCustomThemes((prev) => [...prev.filter((x) => x.id !== t.id), t]);
  }, []);

  const deleteCustomTheme = useCallback(async (themeId: string) => {
    await api.deleteCustomTheme(themeId);
    setCustomThemes((prev) => prev.filter((x) => x.id !== themeId));
  }, []);

  return (
    <Ctx.Provider value={{ themes, theme, globalThemeId: id, setThemeId, saveCustomTheme, deleteCustomTheme, setPreviewTheme: setPreview }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}
