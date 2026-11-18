import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { api } from "../api";
import { GAP, panelInset, panelWidths, setPanelWidth } from "../ui/layout";

/**
 * Show/hide state of the two side panels (projects left, chat right), persisted in workspace.json
 * (`show_projects`, `show_chat`). The state is mirrored onto `<html data-left data-right>` so the
 * CSS (panel slide, insets, pills, canvas-placed popups) follows it without re-rendering the canvas.
 * Ctrl+B toggles the left panel, Ctrl+J the right one, from anywhere (also inside popups and fields).
 *
 * Widths (`side_w`, `chat_w`) are resized from a handle on each panel's inner edge: the live drag
 * writes --side-w / --chat-w on <html> (rAF-throttled, no React render), persists on release only.
 * Dragging SNAP px past the minimum collapses the panel; it reopens at its pre-drag width.
 */
type Side = "left" | "right";
const LIMITS: Record<Side, { min: number; def: number; max: number; key: "side_w" | "chat_w" }> = {
  left: { min: 180, def: 224, max: 420, key: "side_w" },
  right: { min: 280, def: 340, max: 720, key: "chat_w" },
};
const SNAP = 60;
const MIN_FREE = 360;
const other = (s: Side): Side => (s === "left" ? "right" : "left");

/** Width limits plus the room the free canvas area must keep (>= MIN_FREE). */
function clampWidth(side: Side, w: number): number {
  const { min, max } = LIMITS[side];
  const room = window.innerWidth - MIN_FREE - panelInset(other(side)) - GAP * 2;
  return Math.round(Math.max(min, Math.min(max, room, w)));
}

const PINS_KEY = "dreamer.chatPins";
function readPins(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function usePanels() {
  // Chat thread pin per project ("project" or a card id), kept in localStorage.
  const [pins, setPins] = useState<Record<string, string>>(readPins);
  const setPin = useCallback((slug: string, thread: string | null) => {
    setPins((p) => {
      if ((p[slug] ?? null) === thread) return p;
      const n = { ...p };
      if (thread) n[slug] = thread;
      else delete n[slug];
      try {
        localStorage.setItem(PINS_KEY, JSON.stringify(n));
      } catch {
        /* storage unavailable: the pin lasts for this session */
      }
      return n;
    });
  }, []);

  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  const loaded = useRef(false);

  // Desired widths (saved or user-set); what's applied is clamped to the window.
  const widths = useRef<Record<Side, number>>({ left: LIMITS.left.def, right: LIMITS.right.def });
  const applyWidths = useCallback(() => {
    setPanelWidth("right", clampWidth("right", widths.current.right));
    setPanelWidth("left", clampWidth("left", widths.current.left));
  }, []);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setLeft(s.show_projects !== false);
        setRight(s.show_chat !== false);
        if (typeof s.side_w === "number") widths.current.left = s.side_w;
        if (typeof s.chat_w === "number") widths.current.right = s.chat_w;
        applyWidths();
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
        // Animate only user toggles, not the restore at startup.
        requestAnimationFrame(() => document.documentElement.setAttribute("data-panels-ready", ""));
      });
  }, [applyWidths]);

  useEffect(() => {
    window.addEventListener("resize", applyWidths);
    return () => window.removeEventListener("resize", applyWidths);
  }, [applyWidths]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.left = left ? "shown" : "hidden";
    root.dataset.right = right ? "shown" : "hidden";
    applyWidths(); // the other panel's room changed
  }, [left, right, applyWidths]);

  // Persist only user toggles, after the state changed (not inside the updater: StrictMode runs
  // updaters twice), so restoring the saved state at startup never writes workspace.json.
  const toggled = useRef(false);
  const toggleLeft = useCallback(() => {
    toggled.current = true;
    setLeft((v) => !v);
  }, []);
  const toggleRight = useCallback(() => {
    toggled.current = true;
    setRight((v) => !v);
  }, []);
  /** Shows the chat panel (no-op when it's already shown). */
  const showRight = useCallback(() => {
    toggled.current = true;
    setRight(true);
  }, []);
  useEffect(() => {
    if (!toggled.current || !loaded.current) return;
    toggled.current = false;
    api.updateSettings({ show_projects: left, show_chat: right }).catch(() => {});
  }, [left, right]);

  const collapse = useCallback((side: Side) => {
    toggled.current = true;
    (side === "left" ? setLeft : setRight)(false);
  }, []);

  const resize = useMemo(() => {
    const handle = (side: Side) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        const root = document.documentElement;
        const id = e.pointerId;
        el.setPointerCapture(id);
        const startX = e.clientX;
        const startW = panelWidths()[side];
        const dir = side === "left" ? 1 : -1;
        let w = startW;
        let snap = false;
        let raf = 0;
        root.dataset.resizing = side;
        const paint = () => {
          raf = 0;
          setPanelWidth(side, w);
          if (snap) root.dataset.snap = side;
          else delete root.dataset.snap;
        };
        const move = (ev: PointerEvent) => {
          const raw = startW + dir * (ev.clientX - startX);
          snap = raw < LIMITS[side].min - SNAP;
          w = clampWidth(side, raw);
          if (!raf) raf = requestAnimationFrame(paint);
        };
        const end = (ev: PointerEvent) => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", end);
          el.removeEventListener("pointercancel", end);
          if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
          cancelAnimationFrame(raf);
          delete root.dataset.resizing;
          if (ev.type === "pointerup" && snap) {
            // Hide right away (no un-faded frame before React commits), back at the pre-drag width.
            root.dataset[side] = "hidden";
            delete root.dataset.snap;
            setPanelWidth(side, startW);
            collapse(side);
            return;
          }
          delete root.dataset.snap;
          if (ev.type !== "pointerup") w = startW;
          setPanelWidth(side, w);
          if (w !== startW) {
            widths.current[side] = w;
            api.updateSettings({ [LIMITS[side].key]: w }).catch(() => {});
          }
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", end);
        el.addEventListener("pointercancel", end);
      },
      onDoubleClick: () => {
        const def = LIMITS[side].def;
        widths.current[side] = def;
        applyWidths();
        api.updateSettings({ [LIMITS[side].key]: def }).catch(() => {});
      },
    });
    return { left: handle("left"), right: handle("right") };
  }, [applyWidths, collapse]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "b") {
        e.preventDefault();
        toggleLeft();
      } else if (k === "j") {
        e.preventDefault();
        toggleRight();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleLeft, toggleRight]);

  return { left, right, toggleLeft, toggleRight, showRight, pins, setPin, resize };
}
