import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";

/**
 * Show/hide state of the two side panels (projects left, chat right), persisted in workspace.json
 * (`show_projects`, `show_chat`). The state is mirrored onto `<html data-left data-right>` so the
 * CSS (panel slide, insets, pills, canvas-placed popups) follows it without re-rendering the canvas.
 * Ctrl+B toggles the left panel, Ctrl+J the right one, from anywhere (also inside popups and fields).
 */
export function usePanels() {
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  const loaded = useRef(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setLeft(s.show_projects !== false);
        setRight(s.show_chat !== false);
      })
      .catch(() => {})
      .finally(() => {
        loaded.current = true;
        // Animate only user toggles, not the restore at startup.
        requestAnimationFrame(() => document.documentElement.setAttribute("data-panels-ready", ""));
      });
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.left = left ? "shown" : "hidden";
    root.dataset.right = right ? "shown" : "hidden";
  }, [left, right]);

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
  useEffect(() => {
    if (!toggled.current || !loaded.current) return;
    toggled.current = false;
    api.updateSettings({ show_projects: left, show_chat: right }).catch(() => {});
  }, [left, right]);

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

  return { left, right, toggleLeft, toggleRight };
}
