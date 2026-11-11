import { useEffect, useRef } from "react";

/** Open dialogs, oldest first. Only the last one reacts to Esc. */
const stack: symbol[] = [];

/** Esc closes the top-most open dialog only (not every dialog stacked under it). */
export function useEscClose(onClose: () => void) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    const token = Symbol("dialog");
    stack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stack[stack.length - 1] === token) {
        e.stopPropagation();
        cb.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
}

/** True while any dialog is open (so global shortcuts like the canvas's Esc can stand down). */
export const dialogOpen = () => stack.length > 0;
