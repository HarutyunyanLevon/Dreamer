import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Layer } from "../ui/Layer";

/**
 * One context menu for the whole canvas (cards, ghosts, selections, links, frames, objects, empty
 * canvas). Frosted glass, opens at the pointer and stays inside the window. Sections are split by
 * separators; items can open submenus (hover, Right arrow or Enter). Typing anything shows a
 * filter field that searches every item, submenus included. Disabled items say why in a tooltip.
 */
export interface MenuItem {
  label: string;
  /** Shortcut hint shown on the right, e.g. "Ctrl+D". */
  hint?: string;
  /** Leading glyph (stage dot, swatch, check). */
  icon?: ReactNode;
  checked?: boolean;
  /** Why the item can't be used right now; presence disables it. */
  disabled?: string;
  danger?: boolean;
  run?: () => void;
  submenu?: MenuSection[];
}
export interface MenuSection {
  /** Names the group for screen readers (Add, Claude, Arrange, Danger…). */
  title?: string;
  items: MenuItem[];
}

const EDGE = 8;
const flat = (sections: MenuSection[]) => sections.flatMap((s) => s.items);

/** Every runnable leaf, labelled with its submenu path ("Add › Sticky"), for type-to-filter. */
function leaves(sections: MenuSection[], prefix = ""): { path: string; item: MenuItem }[] {
  return flat(sections).flatMap((it) =>
    it.submenu ? leaves(it.submenu, `${prefix}${it.label} › `) : [{ path: prefix + it.label, item: it }],
  );
}

export function ContextMenu({ x, y, label, sections, onClose }: { x: number; y: number; label: string; sections: MenuSection[]; onClose: () => void }) {
  /** open[i] = index (at level i) of the item whose submenu is shown at level i+1. */
  const [open, setOpen] = useState<number[]>([]);
  /** Keyboard/hover focus: level and index within that level. */
  const [active, setActive] = useState<{ level: number; index: number }>({ level: 0, index: -1 });
  const [query, setQuery] = useState("");
  const anchors = useRef<(DOMRect | null)[]>([]);

  const levels = useMemo(() => {
    const out: MenuSection[][] = [sections];
    for (const i of open) {
      const sub = flat(out[out.length - 1])[i]?.submenu;
      if (!sub) break;
      out.push(sub);
    }
    return out;
  }, [sections, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? leaves(sections).filter((l) => l.path.toLowerCase().includes(q)) : [];
  }, [sections, query]);

  const runItem = (it: MenuItem) => {
    if (it.disabled || !it.run) return;
    onClose();
    it.run();
  };

  const openSub = (level: number, index: number, focusFirst: boolean, anchor: DOMRect | null) => {
    anchors.current[level] = anchor;
    setOpen((o) => [...o.slice(0, level), index]);
    setActive(focusFirst ? { level: level + 1, index: 0 } : { level, index });
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Esc is handled here so it can close one submenu at a time (Layer's Esc would close everything).
    if (query) {
      const n = filtered.length;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
        setActive({ level: 0, index: -1 });
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const down = e.key === "ArrowDown";
        if (n) setActive((a) => ({ level: 0, index: a.index < 0 ? (down ? 0 : n - 1) : (a.index + (down ? 1 : n - 1)) % n }));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = filtered[Math.max(0, active.index)];
        if (hit) runItem(hit.item);
      }
      return;
    }
    const level = Math.min(active.level, levels.length - 1);
    const items = flat(levels[level]);
    const cur = items[active.index];
    const move = (d: number) => {
      e.preventDefault();
      const n = items.length;
      const from = active.index < 0 ? (d > 0 ? -1 : 0) : active.index;
      setActive({ level, index: (from + d + n) % n });
      setOpen((o) => o.slice(0, level));
    };
    switch (e.key) {
      case "ArrowDown": return move(1);
      case "ArrowUp": return move(-1);
      case "Home": e.preventDefault(); return setActive({ level, index: 0 });
      case "End": e.preventDefault(); return setActive({ level, index: items.length - 1 });
      case "ArrowRight":
        if (cur?.submenu && !cur.disabled) {
          e.preventDefault();
          openSub(level, active.index, true, document.querySelector<HTMLElement>(`[data-cm="${level}:${active.index}"]`)?.getBoundingClientRect() ?? null);
        }
        return;
      case "ArrowLeft":
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (level > 0) {
          setOpen((o) => o.slice(0, level - 1));
          setActive({ level: level - 1, index: open[level - 1] ?? 0 });
        } else if (e.key === "Escape") onClose();
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!cur) return;
        if (cur.submenu) {
          if (!cur.disabled) openSub(level, active.index, true, document.querySelector<HTMLElement>(`[data-cm="${level}:${active.index}"]`)?.getBoundingClientRect() ?? null);
        } else runItem(cur);
        return;
      case "Tab":
        e.preventDefault();
        return;
    }
    // Any printable key starts the filter.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setQuery(e.key);
      setOpen([]);
      setActive({ level: 0, index: 0 });
    }
  };

  return (
    <Layer onClose={onClose}>
      <div className="cm-root" onKeyDown={onKeyDown}>
        {query ? (
          <MenuPanel x={x} y={y} label={label} level={0}>
            <input
              className="cm-filter"
              autoFocus
              value={query}
              aria-label="Filter menu"
              aria-controls="cm-filtered"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive({ level: 0, index: 0 });
              }}
            />
            <div id="cm-filtered" role="group">
              {filtered.length === 0 && <div className="cm-empty">No matching action</div>}
              {filtered.map((l, i) => (
                <Row
                  key={l.path}
                  item={l.item}
                  text={l.path}
                  id={`0:${i}`}
                  active={active.index === i}
                  focus={false}
                  onHover={() => setActive({ level: 0, index: i })}
                  onPick={() => runItem(l.item)}
                />
              ))}
            </div>
          </MenuPanel>
        ) : (
          levels.map((secs, level) => (
            <MenuPanel
              key={level}
              x={x}
              y={y}
              label={level === 0 ? label : flat(levels[level - 1])[open[level - 1]]?.label ?? ""}
              level={level}
              anchor={level > 0 ? anchors.current[level - 1] : null}
            >
              {secs.map((s, si) => {
                const offset = secs.slice(0, si).reduce((n, x) => n + x.items.length, 0);
                return (
                  <div key={si} role="group" aria-label={s.title} className="cm-section">
                    {si > 0 && <div className="cm-sep" role="separator" />}
                    {s.items.map((it, ii) => {
                      const index = offset + ii;
                      const isActive = active.level === level && active.index === index;
                      return (
                        <Row
                          key={index}
                          item={it}
                          id={`${level}:${index}`}
                          active={isActive || open[level] === index}
                          focus={isActive}
                          expanded={it.submenu ? open[level] === index : undefined}
                          onHover={(rect) => {
                            if (it.submenu && !it.disabled) openSub(level, index, false, rect);
                            else {
                              setOpen((o) => o.slice(0, level));
                              setActive({ level, index });
                            }
                          }}
                          onPick={(rect) => {
                            if (it.submenu) {
                              if (!it.disabled) openSub(level, index, true, rect);
                            } else runItem(it);
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </MenuPanel>
          ))
        )}
      </div>
    </Layer>
  );
}

/** One glass panel: the root at the pointer, a submenu beside its parent item; kept on screen. */
function MenuPanel({ x, y, label, level, anchor, children }: { x: number; y: number; label: string; level: number; anchor?: DOMRect | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (anchor) {
      left = anchor.right - 4;
      if (left + w > vw - EDGE) left = anchor.left - w + 4;
      top = anchor.top - 6;
    } else if (x + w > vw - EDGE) left = x - w; // flip to the pointer's left side
    if (!anchor && y + h > vh - EDGE) top = y - h;
    const next = { left: Math.max(EDGE, Math.min(left, vw - w - EDGE)), top: Math.max(EDGE, Math.min(top, vh - h - EDGE)) };
    setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
    // Re-measure when the content changes size (filter results).
  }, [x, y, anchor, children]);
  // The root panel takes focus on open, so arrow keys and type-to-filter work without a click.
  useLayoutEffect(() => {
    if (level === 0 && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, [level]);
  return (
    <div
      ref={ref}
      className="card-menu cm glass"
      role="menu"
      aria-label={label}
      data-level={level}
      tabIndex={-1}
      data-wheel-boundary=""
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? undefined : "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

function Row({
  item,
  text,
  id,
  active,
  focus,
  expanded,
  onHover,
  onPick,
}: {
  item: MenuItem;
  text?: string;
  id: string;
  active: boolean;
  focus: boolean;
  expanded?: boolean;
  onHover: (rect: DOMRect) => void;
  onPick: (rect: DOMRect) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (focus) ref.current?.focus({ preventScroll: true });
  }, [focus]);
  const role = item.checked !== undefined ? "menuitemcheckbox" : "menuitem";
  return (
    <button
      ref={ref}
      type="button"
      role={role}
      tabIndex={-1}
      data-cm={id}
      aria-checked={item.checked}
      aria-disabled={item.disabled ? true : undefined}
      aria-haspopup={item.submenu ? "menu" : undefined}
      aria-expanded={expanded}
      aria-keyshortcuts={item.hint ? item.hint.replace(/Ctrl/g, "Control").replace(/Del$/, "Delete") : undefined}
      title={item.disabled}
      className={"menu-item cm-item" + (active ? " on" : "") + (item.danger ? " danger" : "") + (item.disabled ? " disabled" : "")}
      onPointerEnter={(e) => onHover(e.currentTarget.getBoundingClientRect())}
      onClick={(e) => onPick(e.currentTarget.getBoundingClientRect())}
    >
      <span className="cm-icon" aria-hidden="true">{item.icon ?? (item.checked ? "✓" : null)}</span>
      <span className="cm-label">{text ?? item.label}</span>
      {item.submenu ? <span className="cm-hint cm-chev" aria-hidden="true">›</span> : item.hint ? <span className="cm-hint">{item.hint}</span> : null}
    </button>
  );
}
