import { useRef, type ReactNode } from "react";
import { Layer } from "./Layer";
import { ScrollArea, useDragScroll } from "./Scroll";

/**
 * Shared dialog shell, used by every dialog in the app. It sits in the popup `Layer` (portal into
 * `document.body`, input isolation, click-outside and Esc to close), is fixed in place (not
 * draggable), scrolls its content with the shared scroll system, and supports drag-to-scroll on
 * non-interactive content. Wheel input never reaches the canvas.
 *
 * `size`: "sm" prompts, "md" lists, "lg" editors (card editor, theme editor, compare). Window-centred
 * dialogs are min(90vw, preferred width) wide and never narrower than ~420px (see styles.css).
 * `align`: "center" (default) or "top" (the Ctrl+K search box).
 * `placement`: "window" (default) centres the dialog in the window; "canvas" keeps it inside the
 * free area between the project sidebar and the chat panel (card editor, fork compare), sized to
 * that area and following it live as panels are shown or hidden or the window is resized.
 */
export function Modal({
  onClose,
  label,
  size = "md",
  align = "center",
  placement = "window",
  className,
  onPaste,
  children,
}: {
  onClose: () => void;
  label: string;
  size?: "sm" | "md" | "lg";
  align?: "center" | "top";
  placement?: "window" | "canvas";
  className?: string;
  onPaste?: (e: React.ClipboardEvent) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement | null>(null);
  useDragScroll(panel);
  return (
    <Layer onClose={onClose} scope={placement === "canvas" ? "canvas" : "window"}>
      <div className={`modal-stage align-${align} place-${placement}`}>
        <ScrollArea
          ref={panel}
          boundary
          className={`modal glass modal-${size}${className ? ` ${className}` : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onPaste={onPaste}
        >
          {children}
        </ScrollArea>
      </div>
    </Layer>
  );
}
