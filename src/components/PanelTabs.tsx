/**
 * The two bookmark tabs at the top window edges: left toggles the project sidebar (Ctrl+B), right
 * toggles the chat panel (Ctrl+J). They stay put, flush with the window edge, so they remain the one
 * visible handle when their panel is hidden. 30x52px (the 44px minimum is the height; the width is
 * the edge strip the tab lives in).
 */
export function PanelTabs({ left, right, onLeft, onRight }: { left: boolean; right: boolean; onLeft: () => void; onRight: () => void }) {
  return (
    <>
      <Tab side="left" open={left} name="projects" keys="Ctrl+B" aria="Control+B" controls="projects-panel" onClick={onLeft} />
      <Tab side="right" open={right} name="chat" keys="Ctrl+J" aria="Control+J" controls="chat-panel" onClick={onRight} />
    </>
  );
}

function Tab({ side, open, name, keys, aria, controls, onClick }: { side: "left" | "right"; open: boolean; name: string; keys: string; aria: string; controls: string; onClick: () => void }) {
  const label = `${open ? "Hide" : "Show"} ${name}`;
  // Chevron points the way the panel will move: a shown left panel slides left, etc.
  const pointsLeft = side === "left" ? open : !open;
  return (
    <button
      type="button"
      className={`panel-tab panel-tab-${side}${open ? " open" : ""}`}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      aria-keyshortcuts={aria}
      title={`${label} (${keys})`}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={pointsLeft ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
      </svg>
    </button>
  );
}
