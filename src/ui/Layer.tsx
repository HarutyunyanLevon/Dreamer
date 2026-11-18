import { useRef, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useEscClose } from "../util/useEscClose";

/**
 * The one popup layer every dialog, menu and popover sits in (see docs/decisions.md, fix pass #3).
 *
 * - Rendered through a portal into `document.body`, so no frosted (backdrop-filter) panel can trap
 *   `position: fixed` and no ancestor's layout can clip it.
 * - React events from a portal still bubble up the *React* tree (e.g. from the card editor to the
 *   canvas's pan handler). The layer root stops every pointer, mouse, click, wheel and drag event
 *   there, so nothing inside a popup ever reaches the canvas, a card or a panel. Keyboard events
 *   are not stopped (Esc handling and the global Ctrl+B / Ctrl+J / Ctrl+K shortcuts listen on
 *   `window`); the canvas checks `dialogOpen()` instead.
 * - A full-window scrim under the popup swallows input meant for the canvas, grid and panels.
 *   A click on the scrim (press and release both on it) closes the popup and does nothing else.
 * - `scope="canvas"` (card editor, fork compare): the scrim stops at the chat panel's left edge, so the
 *   chat stays fully interactive; Esc pressed inside the chat only blurs the field.
 * - Esc closes only the top-most popup (`useEscClose`).
 */
export function Layer({
  onClose,
  className,
  scope = "window",
  children,
}: {
  onClose: () => void;
  className?: string;
  /** "canvas": the scrim covers the canvas and project sidebar only; the chat panel stays live. */
  scope?: "window" | "canvas";
  children: ReactNode;
}) {
  // In canvas scope, Esc from inside the chat panel only blurs the focused field.
  useEscClose(onClose, (e) => {
    if (scope !== "canvas") return false;
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.("#chat-panel")) return false;
    t.blur?.();
    return true;
  });
  // Close on click only if the press also started on the scrim: a text selection that is dragged
  // out of a field and released over the scrim must not close the popup.
  const pressOnScrim = useRef(false);
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <div
      className={"layer" + (scope === "canvas" ? " scope-canvas" : "") + (className ? ` ${className}` : "")}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onMouseDown={stop}
      onMouseUp={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onWheel={stop}
      onDragOver={stop}
      onDrop={stop}
    >
      <div
        className="layer-scrim"
        aria-hidden="true"
        onPointerDown={(e) => {
          pressOnScrim.current = e.button === 0;
        }}
        onClick={(e) => {
          if (pressOnScrim.current && e.target === e.currentTarget) onClose();
          pressOnScrim.current = false;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      {children}
    </div>,
    document.body,
  );
}
