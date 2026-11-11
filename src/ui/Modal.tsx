import { useRef, type ReactNode } from "react";
import { useEscClose } from "../util/useEscClose";
import { ScrollArea, useWheelBoundary } from "./Scroll";

/**
 * Shared dialog shell: dimmed backdrop (click to close), frosted panel that scrolls with the shared
 * scroll system, Esc closes only the top-most dialog, and wheel input never reaches the canvas.
 * `size`: "sm" prompts, "md" lists, "lg" editors (card editor, theme editor, compare).
 */
export function Modal({
  onClose,
  label,
  size = "md",
  className,
  backdropClassName,
  onPaste,
  children,
}: {
  onClose: () => void;
  label: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  backdropClassName?: string;
  onPaste?: (e: React.ClipboardEvent) => void;
  children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement | null>(null);
  useWheelBoundary(backdrop);
  useEscClose(onClose);
  return (
    <div ref={backdrop} className={"modal-backdrop" + (backdropClassName ? ` ${backdropClassName}` : "")} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <ScrollArea boundary className={`modal glass modal-${size}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={label} onPaste={onPaste}>
        {children}
      </ScrollArea>
    </div>
  );
}
