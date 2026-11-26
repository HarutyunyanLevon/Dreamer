import { useRef, useState } from "react";
import type { ModelTier } from "../../api/claude";
import { MenuSep, Popover } from "./Popover";

const TIERS: { tier: ModelTier; label: string }[] = [
  { tier: "fast", label: "Fast" },
  { tier: "main", label: "Main" },
  { tier: "deep", label: "Deep" },
];

/** The composer's model chip: Auto or a pinned tier, and model settings. */
export function ModelChip({
  pin,
  onPin,
  tierName,
  autoHelp,
  onModels,
}: {
  pin: ModelTier | null;
  onPin: (t: ModelTier | null) => void;
  tierName: (t: ModelTier) => string;
  /** What Auto does right now. */
  autoHelp: string;
  onModels: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const label = pin ? tierName(pin) : "Auto";
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
    btn.current?.focus();
  };
  return (
    <div className="model-menu">
      <button
        ref={btn}
        type="button"
        className={"model-chip" + (pin ? " on" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={pin ? `Pinned to ${label}.` : autoHelp}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-chip-label">{label}</span>
      </button>
      {open && (
        <Popover anchor={btn} onClose={() => setOpen(false)} label="Model" className="pop-up pop-right">
          <button type="button" role="menuitemradio" aria-checked={pin === null} className="menu-item cm-item two-line" onClick={() => pick(() => onPin(null))}>
            <span className="cm-icon" aria-hidden="true">{pin === null && "✓"}</span>
            <span className="cm-label">
              Auto
              <span className="cm-desc">{autoHelp}</span>
            </span>
          </button>
          {TIERS.map(({ tier, label: l }) => (
            <button key={tier} type="button" role="menuitemradio" aria-checked={pin === tier} className="menu-item cm-item" title={`Pin every message to ${tierName(tier)} until you change it`} onClick={() => pick(() => onPin(tier))}>
              <span className="cm-icon" aria-hidden="true">{pin === tier && "✓"}</span>
              <span className="cm-label">{l}</span>
              <span className="cm-hint">{tierName(tier)}</span>
            </button>
          ))}
          <MenuSep />
          <button type="button" role="menuitem" className="menu-item cm-item" title="Which Claude models Dreamer uses" onClick={() => pick(onModels)}>
            <span className="cm-icon" aria-hidden="true" />
            <span className="cm-label">Model settings…</span>
          </button>
        </Popover>
      )}
    </div>
  );
}
