import { useRef, useState, type ReactNode } from "react";
import { MenuSep, Popover } from "./Popover";

/** The header's ⋯ menu: Memory, Model settings, Reset chat. `info` is a non-interactive line on top (context meter). */
export function PanelMenu({
  onMemory,
  onModels,
  onReset,
  resetDisabled,
  resetTitle,
  info,
}: {
  /** null hides the item (the Inbox has no memory). */
  onMemory: (() => void) | null;
  onModels: () => void;
  onReset: () => void;
  resetDisabled: boolean;
  resetTitle: string;
  info?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div className="panel-menu">
      <button ref={btn} type="button" className="icon-btn head-more" aria-label="Chat options" aria-haspopup="menu" aria-expanded={open} title="Chat options" onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <circle cx="5.5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18.5" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => setOpen(false)} label="Chat options" className="pop-right">
          {info && <div className="pop-info">{info}</div>}
          {onMemory && (
            <button type="button" role="menuitem" className="menu-item cm-item" title="What Dreamer remembers about this project" onClick={() => pick(onMemory)}>
              <span className="cm-label">Memory…</span>
            </button>
          )}
          <button type="button" role="menuitem" className="menu-item cm-item" title="Which Claude models Dreamer uses" onClick={() => pick(onModels)}>
            <span className="cm-label">Model settings…</span>
          </button>
          <MenuSep />
          <button type="button" role="menuitem" className="menu-item cm-item danger" disabled={resetDisabled} title={resetTitle} onClick={() => pick(onReset)}>
            <span className="cm-label">Reset chat</span>
          </button>
        </Popover>
      )}
    </div>
  );
}
