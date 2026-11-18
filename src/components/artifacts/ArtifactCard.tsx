import { api, type Card } from "../../api";
import { useArtifactRun, useSpritecookNote } from "../../state/artifactRuns";
import { ArtifactFrame } from "./ArtifactFrame";
import { ArtifactIcon } from "./ArtifactIcon";
import { RunBar, artModeLabel } from "./ArtifactView";
import { coverOf, useArtifact, useArtifactFileUrl } from "./hooks";
import { ARTIFACT_LABEL, artifactType } from "./prompts";

/** The head row of an artifact card: type icon and type name (the title is the card's h3). */
export function ArtifactHead({ card, menu }: { card: Card; menu: React.ReactNode }) {
  const type = artifactType(card);
  return (
    <div className="card-head artifact-head">
      <span className="artifact-type-icon small" aria-hidden="true">
        <ArtifactIcon type={type} size={14} />
      </span>
      <span className="stage-name">{ARTIFACT_LABEL[type]}</span>
      {menu}
    </div>
  );
}

/**
 * The body of an artifact card, top to bottom: title, theme pill (+ art-mode pill when
 * overridden), preview, version picker and Approved badge, suggestion chips, and the running state
 * with the SpriteCook job progress. Double-click (on the card) opens the full-size view.
 */
export function ArtifactCardBody({ card, slug, onChip, onOpen, onSettings }: { card: Card; slug: string | null; onChip: (id: string, prompt: string, label: string) => void; onOpen: (id: string) => void; onSettings: () => void }) {
  const { view, setView, stamp } = useArtifact(slug, card.id);
  const run = useArtifactRun(card.id);
  const note = useSpritecookNote(card.id);
  const v = view?.versions.find((x) => x.n === view.currentVersion);
  const cover = view ? coverOf(view, v) : null;
  const imgUrl = useArtifactFileUrl(slug, card.id, v?.n, cover && cover.kind !== "html" ? cover.file : undefined, stamp);
  const themeName = view ? (view.type === "theme" ? (view.isActiveTheme ? "Active theme" : null) : view.inherited ? view.inherited.title : "No theme") : null;
  return (
    <>
      <h3>{card.title}</h3>
      {view && (
        <div className="artifact-pills">
          {themeName && (
            <span className={"artifact-pill" + (view.type === "theme" && view.isActiveTheme ? " active" : "")} title={view.type === "theme" ? "New artifacts inherit this theme" : view.themeId ? "Theme picked for this artifact" : "The project's active theme"}>
              {view.type !== "theme" && "◐ "}
              {themeName}
            </span>
          )}
          {view.artMode && <span className="artifact-pill mode" title="Art mode override for this artifact">{artModeLabel(view.artMode)}</span>}
        </div>
      )}
      <div
        className="artifact-preview"
        role="button"
        tabIndex={-1}
        title="Double-click for the full-size view"
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpen(card.id);
        }}
      >
        {!view || !v || !cover ? (
          <div className="artifact-empty">{run ? "Generating…" : view && view.versions.length === 0 ? "Nothing generated yet" : "No preview"}</div>
        ) : cover.kind === "html" ? (
          <div className="artifact-thumb">
            <ArtifactFrame slug={slug!} id={card.id} version={v.n} title={card.title} interactive={false} stamp={stamp} className="thumb" />
          </div>
        ) : !imgUrl ? (
          <div className="image-loading" />
        ) : cover.kind === "video" ? (
          <video src={imgUrl} autoPlay loop muted playsInline />
        ) : (
          <img src={imgUrl} alt={card.title} draggable={false} decoding="async" className={view.effectiveArtMode?.mode === "pixel" ? "pixel" : undefined} />
        )}
        {cover?.kind === "html" && (
          <button
            type="button"
            className="artifact-open-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(card.id);
            }}
          >
            Open full size
          </button>
        )}
      </div>
      {view && view.versions.length > 0 && (
        <div className="artifact-versions">
          <select
            className="artifact-select small"
            aria-label="Version"
            value={view.currentVersion}
            onChange={(e) => void api.artifactUpdate(slug!, card.id, { currentVersion: Number(e.target.value) }).then(setView)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {view.versions.map((x) => (
              <option key={x.n} value={x.n}>
                v{x.n}
              </option>
            ))}
          </select>
          {view.approvedVersion != null && (
            <span className={"artifact-approved" + (view.approvedVersion === view.currentVersion ? "" : " other")} title="Only the approved version goes into the handoff pack">
              ✓ Approved{view.approvedVersion === view.currentVersion ? "" : ` v${view.approvedVersion}`}
            </span>
          )}
          {v && v.credits > 0 && <span className="artifact-credits">{v.credits} cr</span>}
        </div>
      )}
      {note && !run && (
        <button
          type="button"
          className="artifact-note"
          onClick={(e) => {
            e.stopPropagation();
            onSettings();
          }}
        >
          {note.reason === "no_key" ? "Images need a SpriteCook key: Settings" : "SpriteCook unreachable: check Settings"}
        </button>
      )}
      {run ? (
        <RunBar run={run} compact />
      ) : (
        view &&
        view.suggestions.length > 0 && (
          <div className="artifact-chips">
            {view.suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                className="chip artifact-chip"
                title={`${s.prompt}${s.estCredits != null ? ` (~${s.estCredits} credits)` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onChip(card.id, s.prompt, s.label);
                }}
              >
                {s.label}
                {s.estCredits != null && <span className="chip-cost">~{s.estCredits}</span>}
              </button>
            ))}
          </div>
        )
      )}
    </>
  );
}
