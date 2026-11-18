import { Fragment, useEffect, useRef } from "react";
import { Popover } from "./Popover";

export interface ChatAction {
  id: string;
  label: string;
  desc: string;
  group: "card" | "project";
  /** Text Tab inserts into the composer (so an instruction can follow); none = Tab runs it. */
  command?: string;
  /** Why it can't run here; shown inline, and picking it explains instead of running. */
  disabled?: { short: string; long: string };
  run: () => void;
}

const GROUP_LABEL = { card: "This card", project: "Project" } as const;

/** Items whose label or command matches the text typed after "/". */
export function filterActions(actions: ChatAction[], query: string): ChatAction[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  if (!q) return actions;
  return actions.filter((a) => a.label.toLowerCase().replace(/^\//, "").includes(q) || a.command?.toLowerCase().replace(/^\//, "").startsWith(q));
}

/**
 * The composer's action menu, opened by "+" (focus moves into it) or by typing "/" (focus stays in
 * the textarea, which drives `active` with the arrow keys).
 */
export function ActionMenu({
  actions,
  anchor,
  fromSlash,
  active,
  setActive,
  notice,
  onPick,
  onClose,
}: {
  actions: ChatAction[];
  anchor: React.RefObject<HTMLElement | null>;
  fromSlash: boolean;
  active: number;
  setActive: (i: number) => void;
  notice: string | null;
  onPick: (a: ChatAction) => void;
  onClose: () => void;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  let i = -1;
  const groups = (["card", "project"] as const).map((g) => ({ g, items: actions.filter((a) => a.group === g) })).filter((x) => x.items.length);
  return (
    <Popover anchor={anchor} onClose={onClose} label="Actions" className="pop-up action-menu" autoFocus={!fromSlash}>
      <div ref={list} className="action-list scroll scroll-y">
        {groups.map(({ g, items }) => (
          <Fragment key={g}>
            <div className="menu-heading" aria-hidden="true">{GROUP_LABEL[g]}</div>
            {items.map((a) => {
              const n = ++i;
              return (
                <button
                  key={a.id}
                  id={`chat-action-${a.id}`}
                  data-i={n}
                  type="button"
                  role="menuitem"
                  tabIndex={fromSlash ? -1 : 0}
                  aria-disabled={a.disabled ? true : undefined}
                  className={"menu-item cm-item two-line" + (fromSlash && n === active ? " on" : "") + (a.disabled ? " soft-disabled" : "")}
                  onMouseEnter={() => setActive(n)}
                  onMouseDown={(e) => fromSlash && e.preventDefault()}
                  onClick={() => onPick(a)}
                >
                  <span className="cm-label">
                    {a.label}
                    <span className="cm-desc">{a.disabled ? a.disabled.short : a.desc}</span>
                  </span>
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
      {notice && (
        <div className="pop-info action-notice" role="status">
          {notice}
        </div>
      )}
    </Popover>
  );
}
