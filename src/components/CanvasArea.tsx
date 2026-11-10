import { useState } from "react";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { IconCard, IconClip, IconFit, IconImage, IconLink, IconMinus, IconPlus } from "./Icons";

// Temporary showcase cards so the stage looks can be judged. Replaced by real cards in step 4.
const DEMO: { id: string; stage: StageId; title: string; body: string; x: number; y: number; ghost?: boolean }[] = [
  { id: "a", stage: "cloud", title: "Fish that fight back", body: "What if the lake bites first?", x: 290, y: 120 },
  { id: "b", stage: "sketch", title: "Chill loop", body: "Cast, wait, let the combo breathe.", x: 570, y: 100 },
  { id: "c", stage: "draft", title: "Harpoon-rod hybrid", body: "One tool, two moods: patient and loud.", x: 830, y: 160 },
  { id: "d", stage: "pitch", title: "Fish-punk: the pitch", body: "Doom energy at a calm pace. Reel in a riff.", x: 330, y: 340 },
  { id: "e", stage: "sketch", title: "Rust-lake biome", body: "Neon bait glowing in oily water.", x: 640, y: 370, ghost: true },
];

export function CanvasArea() {
  const [filter, setFilter] = useState<Set<StageId>>(new Set(STAGES));
  const toggle = (s: StageId) =>
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <main className="canvas" aria-label="Canvas">
      {/* Grid + world share pan/zoom variables so step 4 only has to set them. */}
      <div className="grid" />
      <div className="world">
        {DEMO.filter((c) => filter.has(c.stage)).map((c) => (
          <article
            key={c.id}
            className={`card stage-${c.stage}` + (c.ghost ? " ghost" : "")}
            style={{ left: c.x, top: c.y }}
          >
            {c.ghost && <div className="ghost-label">Claude suggests</div>}
            <div className="card-head">
              <span className={`dot dot-${c.stage}`} aria-hidden="true" />
              <span className="stage-name">{STAGE_LABEL[c.stage]}</span>
            </div>
            <h3>{c.title}</h3>
            <p>{c.body}</p>
            {c.ghost && (
              <div className="ghost-actions">
                <button type="button" className="btn primary">Keep</button>
                <button type="button" className="btn">Dismiss</button>
              </div>
            )}
          </article>
        ))}
      </div>

      <div className="pill title-pill">
        <span className="proj-title">Fish-punk fishing</span>
        <span className="pill-sep" />
        <div className="stage-filter" role="group" aria-label="Stage filter">
          {STAGES.map((s) => (
            <button
              key={s}
              type="button"
              className={"filter" + (filter.has(s) ? " on" : "")}
              aria-pressed={filter.has(s)}
              onClick={() => toggle(s)}
            >
              <span className={`dot dot-${s}`} aria-hidden="true" />
              {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="pill zoom-pill" aria-label="Zoom">
        <button type="button" className="icon-btn" aria-label="Zoom out"><IconMinus /></button>
        <span className="zoom-val">100%</span>
        <button type="button" className="icon-btn" aria-label="Zoom in"><IconPlus /></button>
        <button type="button" className="icon-btn" aria-label="Fit to content"><IconFit /></button>
      </div>

      <div className="pill toolbar" role="toolbar" aria-label="Add">
        <button type="button" className="tool"><IconCard /><span>Card</span></button>
        <button type="button" className="tool"><IconLink /><span>Link</span></button>
        <button type="button" className="tool"><IconImage /><span>Image</span></button>
        <button type="button" className="tool"><IconClip /><span>Web clip</span></button>
      </div>
    </main>
  );
}
