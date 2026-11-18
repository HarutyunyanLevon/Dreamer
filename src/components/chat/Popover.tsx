import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

/** Menu items inside a popover, for arrow-key navigation. */
const ITEMS = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

/** Arrow / Home / End move focus between the menu's enabled items. */
export function menuKeys(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ITEMS)].filter((el) => !el.hasAttribute("disabled"));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const go = (n: number) => {
    e.preventDefault();
    items[(n + items.length) % items.length].focus();
  };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
}

/**
 * A small glass popover inside the chat panel (one floating layer; menus never nest). Closes on
 * Esc, on a press outside it and its anchor, and returns focus to the anchor on Esc.
 */
export function Popover({
  anchor,
  onClose,
  className,
  label,
  role = "menu",
  autoFocus = true,
  children,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  label: string;
  role?: "menu" | "dialog";
  autoFocus?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLElement>(`${ITEMS}:not([disabled])`)?.focus();
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.current?.contains(t)) close.current();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [anchor, autoFocus]);
  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={"chat-pop glass" + (className ? ` ${className}` : "")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close.current();
          anchor.current?.focus();
          return;
        }
        if (e.key === "Tab") close.current();
        if (role === "menu") menuKeys(e);
      }}
    >
      {children}
    </div>
  );
}

export function MenuSep() {
  return <div className="cm-sep" role="separator" />;
}
