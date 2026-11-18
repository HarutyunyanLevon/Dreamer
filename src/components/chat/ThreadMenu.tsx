import { useRef, useState } from "react";
import { api, type Card } from "../../api";
import { IconPin } from "../Icons";
import { MenuSep, Popover } from "./Popover";

/** The header's thread dropdown: Project, recent card threads, and the pin toggle. */
export function ThreadMenu({
  slug,
  cards,
  card,
  pinned,
  onProject,
  onCard,
  onTogglePin,
}: {
  slug: string | null;
  cards: Card[];
  /** The thread's card (null = project thread). */
  card: Card | null;
  pinned: boolean;
  onProject: () => void;
  onCard: (id: string) => void;
  onTogglePin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Card[]>([]);
  const btn = useRef<HTMLButtonElement | null>(null);
  const name = card ? card.title || "Untitled" : "Project";

  const toggle = () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (!slug) return;
    api
      .listChats(slug)
      .then((ids) => setRecent(ids.map((id) => cards.find((c) => c.id === id && !c.ghost)).filter((c): c is Card => !!c).slice(0, 8)))
      .catch(() => setRecent([]));
  };
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
    btn.current?.focus();
  };

  return (
    <div className="thread-menu">
      <button
        ref={btn}
        type="button"
        className="thread-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={pinned ? `Pinned thread: ${name}` : `Thread: ${name}`}
        onClick={toggle}
      >
        {pinned && <span className="thread-pin" title="Pinned"><IconPin /></span>}
        {card && <span className={`dot dot-${card.stage}`} aria-hidden="true" />}
        <span className="thread-name">{name}</span>
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => setOpen(false)} label="Chat threads" className="pop-left">
          <button type="button" role="menuitemradio" aria-checked={!card} className="menu-item cm-item" onClick={() => pick(onProject)}>
            <span className="cm-icon" aria-hidden="true">{!card && "✓"}</span>
            <span className="cm-label">Project</span>
          </button>
          {recent.length > 0 && <div className="menu-heading" aria-hidden="true">Recent cards</div>}
          {recent.map((c) => (
            <button key={c.id} type="button" role="menuitemradio" aria-checked={card?.id === c.id} className="menu-item cm-item" onClick={() => pick(() => onCard(c.id))}>
              <span className="cm-icon" aria-hidden="true">{card?.id === c.id ? "✓" : <span className={`dot dot-${c.stage}`} />}</span>
              <span className="cm-label">{c.title || "Untitled"}</span>
            </button>
          ))}
          <MenuSep />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={pinned}
            disabled={!slug}
            className="menu-item cm-item"
            title="Keep this thread while you select other cards"
            onClick={() => pick(onTogglePin)}
          >
            <span className="cm-icon" aria-hidden="true">{pinned ? "✓" : <IconPin />}</span>
            <span className="cm-label">Pin this thread</span>
          </button>
        </Popover>
      )}
    </div>
  );
}
