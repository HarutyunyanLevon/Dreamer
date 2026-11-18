import { useRef, useState } from "react";
import type { LocalStatus, ModelTier } from "../../api/claude";
import { MenuSep, Popover } from "./Popover";

const TIERS: { tier: ModelTier; label: string }[] = [
  { tier: "fast", label: "Fast" },
  { tier: "main", label: "Main" },
  { tier: "deep", label: "Deep" },
];

/** The composer's model chip: Auto or a pinned tier, the local model's status, model settings. */
export function ModelChip({
  pin,
  onPin,
  tierName,
  autoHelp,
  localOn,
  localStatus,
  localModel,
  onLocalSetup,
  onModels,
}: {
  pin: ModelTier | null;
  onPin: (t: ModelTier | null) => void;
  tierName: (t: ModelTier) => string;
  /** What Auto does right now (router / local explanation). */
  autoHelp: string;
  localOn: boolean;
  localStatus: LocalStatus | null;
  localModel: string;
  onLocalSetup: () => void;
  onModels: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const ready = localOn && !!localStatus?.ready;
  const dot = !localOn ? null : ready ? "ok" : "warn";
  const label = pin ? tierName(pin) : "Auto";
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
    btn.current?.focus();
  };
  const localText = !localOn ? "Local chat is off" : ready ? `Chat runs on ${localStatus!.model} through Ollama` : localStatus?.error ?? "Checking Ollama…";
  return (
    <div className="model-menu">
      <button
        ref={btn}
        type="button"
        className={"model-chip" + (pin ? " on" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={pin ? `Pinned to ${label}. ${localText}.` : `${autoHelp} ${localText}.`}
        onClick={() => setOpen((o) => !o)}
      >
        {dot && <span className={`status-dot ${dot}`} aria-hidden="true" />}
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
          {ready ? (
            <button type="button" role="menuitem" className="menu-item cm-item" title={`${localText}. Click for details.`} onClick={() => pick(onLocalSetup)}>
              <span className="cm-icon" aria-hidden="true"><span className="status-dot ok" /></span>
              <span className="cm-label">Local: {localStatus!.model || localModel} via Ollama</span>
            </button>
          ) : (
            <button type="button" role="menuitem" className="menu-item cm-item" title={localText} onClick={() => pick(onLocalSetup)}>
              <span className="cm-icon" aria-hidden="true">{dot && <span className={`status-dot ${dot}`} />}</span>
              <span className="cm-label">Set up local model</span>
            </button>
          )}
          <button type="button" role="menuitem" className="menu-item cm-item" title="Which Claude models Dreamer uses" onClick={() => pick(onModels)}>
            <span className="cm-icon" aria-hidden="true" />
            <span className="cm-label">Model settings…</span>
          </button>
        </Popover>
      )}
    </div>
  );
}
