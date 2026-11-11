import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { themeVars } from "../theme/applyTheme";
import { checkTheme } from "../theme/contrast";
import { useTheme } from "../theme/ThemeContext";
import { STAGES, STAGE_LABEL, type StageId, type Theme } from "../theme/types";
import { Modal } from "../ui/Modal";
import { IconClose, IconTrash } from "./Icons";

function slugifyId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${base || "theme"}-${Math.random().toString(36).slice(2, 7)}`;
}

const UI_COLOR_KEYS = ["ink", "body", "muted", "link", "accent", "ghost", "ghostText", "fallbackBg"] as const;

export function ThemeEditor({ initial, isNew, onClose }: { initial: Theme; isNew: boolean; onClose: () => void }) {
  const { saveCustomTheme, deleteCustomTheme, setPreviewTheme, setThemeId } = useTheme();
  const [draft, setDraft] = useState<Theme>(() =>
    isNew ? { ...initial, id: slugifyId(`${initial.name} copy`), name: `${initial.name} copy`, builtin: false } : initial,
  );


  useEffect(() => {
    setPreviewTheme(draft);
    return () => setPreviewTheme(null);
  }, [draft, setPreviewTheme]);

  const warnings = useMemo(() => checkTheme(draft).filter((c) => !c.pass), [draft]);

  const setUi = (key: (typeof UI_COLOR_KEYS)[number] | "glass", value: string | number) => setDraft((d) => ({ ...d, ui: { ...d.ui, [key]: value } }));
  const setShader = (key: keyof Theme["shader"], value: number) => setDraft((d) => ({ ...d, shader: { ...d.shader, [key]: value } }));
  const setPalette = (i: number, value: string) =>
    setDraft((d) => {
      const p = [...d.shader.palette] as Theme["shader"]["palette"];
      p[i] = value;
      return { ...d, shader: { ...d.shader, palette: p } };
    });
  const setStage = (s: StageId, value: string) => setDraft((d) => ({ ...d, stages: { ...d.stages, [s]: value } }));

  const save = async () => {
    await saveCustomTheme(draft);
    setThemeId(draft.id);
    onClose();
  };
  const remove = async () => {
    await deleteCustomTheme(draft.id);
    onClose();
  };

  return (
    <Modal onClose={onClose} label={isNew ? "New theme" : `Edit theme ${draft.name}`} size="lg" className="theme-editor">
        <div className="modal-head">
          <input className="editor-title" value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} aria-label="Theme name" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><IconClose /></button>
        </div>

        <div className="theme-editor-grid">
        <div className="theme-controls">
        <div className="editor-row">
          <span className="side-label">Palette</span>
          <div className="swatch-row">
            {draft.shader.palette.map((c, i) => (
              <input key={i} type="color" value={c} onChange={(e) => setPalette(i, e.target.value)} aria-label={`Palette color ${i + 1}`} />
            ))}
          </div>
        </div>

        <div className="editor-row">
          <span className="side-label">Shader</span>
          <div className="slider-grid">
            <Slider label="Frequency" value={draft.shader.freq} min={0} max={4} step={0.05} onChange={(v) => setShader("freq", v)} />
            <Slider label="Falloff" value={draft.shader.fall} min={0} max={1} step={0.02} onChange={(v) => setShader("fall", v)} />
            <Slider label="Sheen" value={draft.shader.sheen} min={0} max={1} step={0.02} onChange={(v) => setShader("sheen", v)} />
            <Slider label="Sheen power" value={draft.shader.sheenPower} min={0} max={8} step={0.1} onChange={(v) => setShader("sheenPower", v)} />
            <Slider label="Mist" value={draft.shader.mist} min={0} max={0.3} step={0.01} onChange={(v) => setShader("mist", v)} />
            <Slider label="Iridescence" value={draft.shader.iridescence} min={0} max={1} step={0.02} onChange={(v) => setShader("iridescence", v)} />
            <Slider label="Speed" value={draft.shader.speed} min={0} max={2} step={0.05} onChange={(v) => setShader("speed", v)} />
          </div>
        </div>

        <div className="editor-row">
          <span className="side-label">UI colors</span>
          <div className="swatch-row">
            {UI_COLOR_KEYS.map((key) => (
              <label key={key} className="color-field">
                <input type="color" value={draft.ui[key]} onChange={(e) => setUi(key, e.target.value)} aria-label={key} />
                <span>{key}</span>
              </label>
            ))}
          </div>
          <Slider label="Glass opacity" value={draft.ui.glass} min={0} max={1} step={0.02} onChange={(v) => setUi("glass", v)} />
        </div>

        <div className="editor-row">
          <span className="side-label">Stage colors</span>
          <div className="swatch-row">
            {STAGES.map((s) => (
              <label key={s} className="color-field">
                <input type="color" value={draft.stages[s]} onChange={(e) => setStage(s, e.target.value)} aria-label={STAGE_LABEL[s]} />
                <span>{STAGE_LABEL[s]}</span>
              </label>
            ))}
          </div>
        </div>

        </div>
        <ThemePreview theme={draft} warnings={warnings} />
        </div>

        <div className="editor-actions">
          {!isNew && (
            <button type="button" className="btn" onClick={() => void remove()}><IconTrash /><span>Delete</span></button>
          )}
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()}>Save</button>
        </div>
    </Modal>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="slider-field">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-val">{value.toFixed(2)}</span>
    </label>
  );
}

/**
 * Live preview of the draft, scoped to this box via the theme's CSS variables (the whole app
 * behind the dialog previews it too). Shows every token in use: glass panel text, accent button,
 * chip, the four stage cards, a ghost card, a link, the scrollbar, and any contrast warnings.
 */
function ThemePreview({ theme, warnings }: { theme: Theme; warnings: { label: string; ratio: number; min: number }[] }) {
  const p = theme.shader.palette;
  const style = {
    ...themeVars(theme),
    background: `radial-gradient(120% 90% at 15% 10%, ${p[1]} 0%, transparent 60%), radial-gradient(100% 80% at 90% 90%, ${p[3]} 0%, transparent 60%), linear-gradient(135deg, ${p[0]}, ${p[2]} 55%, ${p[4]})`,
  } as CSSProperties;
  return (
    <aside className="theme-preview" style={style} aria-label="Theme preview">
      <div className="preview-panel glass">
        <div className="preview-title">{theme.name || "Untitled theme"}</div>
        <p className="preview-body">Body text on glass reads like this.</p>
        <p className="preview-muted">Muted labels and helper text.</p>
        <div className="preview-row">
          <button type="button" className="btn primary" tabIndex={-1}>Primary</button>
          <button type="button" className="chip" tabIndex={-1}>Chip</button>
        </div>
      </div>
      <div className="preview-cards">
        {STAGES.map((s) => (
          <div key={s} className={`card stage-${s}`}>
            <div className="card-head">
              <span className={`dot dot-${s}`} aria-hidden="true" />
              <span className="stage-name">{STAGE_LABEL[s]}</span>
            </div>
            <h3>{STAGE_LABEL[s]} idea</h3>
            <p className="card-body">A line of notes with a <a>link</a>.</p>
          </div>
        ))}
        <div className="card ghost stage-cloud">
          <div className="ghost-label">Claude suggests</div>
          <h3>Ghost card</h3>
        </div>
      </div>
      {warnings.length > 0 ? (
        <div className="contrast-warnings" role="status">
          <span className="side-label">Contrast warnings</span>
          {warnings.map((w) => (
            <div key={w.label} className="warn-row">{w.label}: {w.ratio.toFixed(2)} (needs {w.min})</div>
          ))}
        </div>
      ) : (
        <div className="preview-ok" role="status">All text meets the contrast targets.</div>
      )}
    </aside>
  );
}
