import { useEffect, useMemo, useState } from "react";
import { api, type ArtMode, type ArtifactThemeRef, type ArtifactVersion, type ArtifactVersionInfo, type ArtifactView as View } from "../../api";
import type { Workspace } from "../../state/useWorkspace";
import { useArtifactRun } from "../../state/artifactRuns";
import { Modal } from "../../ui/Modal";
import { renderMarkdown } from "../../util/markdown";
import { ArtifactFrame } from "./ArtifactFrame";
import { ArtifactIcon } from "./ArtifactIcon";
import { useArtifact, useArtifactFileUrl, visualFiles, isVideoFile, isHtmlFile } from "./hooks";
import { ARTIFACT_LABEL } from "./prompts";

export const artModeLabel = (m: ArtMode | null | undefined) => (!m ? "" : m.mode === "pixel" ? `Pixel ${m.pixelSize ?? 32}px` : "HD");
const ART_MODES: (ArtMode | null)[] = [null, { mode: "pixel", pixelSize: 16 }, { mode: "pixel", pixelSize: 32 }, { mode: "pixel", pixelSize: 64 }, { mode: "hd" }];
const modeKey = (m: ArtMode | null | undefined) => (m ? `${m.mode}:${m.mode === "pixel" ? m.pixelSize ?? 32 : ""}` : "");

/** The theme picker of an artifact header: the active theme (default) or a specific one. */
function ThemeSelect({ slug, view, onChange }: { slug: string; view: View; onChange: (v: View) => void }) {
  const [themes, setThemes] = useState<ArtifactThemeRef[]>([]);
  useEffect(() => {
    api.artifactThemes(slug).then(setThemes).catch(() => setThemes([]));
  }, [slug, view.activeTheme]);
  if (view.type === "theme") return null;
  const active = themes.find((t) => t.active);
  return (
    <select
      className="artifact-select"
      aria-label="Theme"
      title="The theme this artifact inherits palette, fonts, art mode and style reference from"
      value={view.themeId ?? ""}
      onChange={(e) => void api.artifactUpdate(slug, view.id, { themeId: e.target.value }).then(onChange)}
    >
      <option value="">{active ? `Active theme: ${active.title}` : "Active theme (none yet)"}</option>
      {themes.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title}
        </option>
      ))}
    </select>
  );
}

/** Art mode: from the theme (default) or a per-artifact override. */
function ArtModeSelect({ slug, view, onChange }: { slug: string; view: View; onChange: (v: View) => void }) {
  const inherited = view.type === "theme" ? null : view.inherited?.spec.artMode;
  return (
    <select
      className="artifact-select"
      aria-label="Art mode"
      title="Art mode for this artifact's images (an override wins over the theme's)"
      value={modeKey(view.artMode)}
      onChange={(e) => {
        const m = ART_MODES.find((x) => modeKey(x) === e.target.value) ?? null;
        void api.artifactUpdate(slug, view.id, { artMode: m }).then(onChange);
      }}
    >
      <option value="">{view.type === "theme" ? "Art mode: from the spec" : inherited ? `From theme (${artModeLabel(inherited)})` : "From theme"}</option>
      {ART_MODES.filter(Boolean).map((m) => (
        <option key={modeKey(m)} value={modeKey(m)}>
          {artModeLabel(m)}
        </option>
      ))}
    </select>
  );
}

/** One version's visuals: an HTML page live in the sandbox, or its images / animations. */
function VersionBody({ slug, view, v, stamp, big }: { slug: string; view: View; v: ArtifactVersion | undefined; stamp: string; big?: boolean }) {
  if (!v) return <div className="artifact-empty">Nothing generated yet.</div>;
  const html = v.files.find((f) => f.file === "index.html") ?? v.files.find((f) => isHtmlFile(f.file));
  const vis = visualFiles(v).filter((f) => !(html && f.file.startsWith("assets/")));
  return (
    <div className="artifact-version-body">
      {html && <ArtifactFrame slug={slug} id={view.id} version={v.n} title={`${view.title} v${v.n}`} className={big ? "big" : "mid"} stamp={stamp} />}
      {vis.length > 0 && (
        <div className={"artifact-gallery" + (html ? " small" : "")}>
          {vis.map((f) => (
            <FileTile key={f.file} slug={slug} id={view.id} version={v.n} file={f.file} role={f.role} stamp={stamp} />
          ))}
        </div>
      )}
      {!html && !vis.length && <div className="artifact-empty">v{v.n} has no images yet.</div>}
    </div>
  );
}

function FileTile({ slug, id, version, file, role, stamp }: { slug: string; id: string; version: number; file: string; role?: string; stamp: string }) {
  const url = useArtifactFileUrl(slug, id, version, file, stamp);
  return (
    <figure className="artifact-tile">
      {!url ? <div className="image-loading" /> : isVideoFile(file) ? <video src={url} autoPlay loop muted playsInline /> : <img src={url} alt={role ?? file} draggable={false} />}
      <figcaption>{role ? `${role} · ` : ""}{file}</figcaption>
    </figure>
  );
}

function VersionPicker({ view, value, onPick, label }: { view: View; value: number; onPick: (n: number) => void; label: string }) {
  return (
    <select className="artifact-select" aria-label={label} value={value} onChange={(e) => onPick(Number(e.target.value))}>
      {view.versions.map((v) => (
        <option key={v.n} value={v.n}>
          v{v.n}
          {v.parent ? ` (from v${v.parent})` : ""}
          {view.approvedVersion === v.n ? " · approved" : ""}
        </option>
      ))}
    </select>
  );
}

/**
 * Double-click on an artifact card: the full-size view. Version picker, Approved, compare two
 * versions side by side, the theme and art-mode overrides, and the brief and design notes.
 */
export function ArtifactFullView({ slug, id, ws, onClose }: { slug: string; id: string; ws: Workspace; onClose: () => void }) {
  const { view, setView, stamp } = useArtifact(slug, id);
  const run = useArtifactRun(id);
  const card = ws.data?.cards.find((c) => c.id === id);
  const [shown, setShown] = useState<number | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const [info, setInfo] = useState<ArtifactVersionInfo | null>(null);
  const n = shown ?? view?.currentVersion ?? 0;
  const v = view?.versions.find((x) => x.n === n);
  useEffect(() => {
    if (!n) return setInfo(null);
    let live = true;
    api.artifactVersionInfo(slug, id, n).then((i) => live && setInfo(i)).catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [slug, id, n, stamp]);
  const notes = useMemo(() => (info?.notes ? renderMarkdown(info.notes) : ""), [info?.notes]);
  const briefHtml = useMemo(() => (info?.brief ? renderMarkdown(info.brief) : card?.body ? renderMarkdown(card.body) : ""), [info?.brief, card?.body]);
  if (!view) return null;
  const title = card?.title || view.title;
  const pick = (k: number) => {
    setShown(k);
    // The picked version becomes the one feedback continues from.
    void api.artifactUpdate(slug, id, { currentVersion: k }).then(setView).catch((e) => ws.setError(String(e)));
  };
  const approved = !!v && view.approvedVersion === v.n;
  const other = compare != null ? view.versions.find((x) => x.n === compare) : undefined;
  return (
    <Modal onClose={onClose} label={`${ARTIFACT_LABEL[view.type]}: ${title}`} size="lg" className="artifact-full">
      <header className="artifact-full-head">
        <span className="artifact-type-icon">
          <ArtifactIcon type={view.type} size={18} />
        </span>
        <h3 className="dialog-title">{title}</h3>
        <span className="artifact-pill">{ARTIFACT_LABEL[view.type]}</span>
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="artifact-full-bar">
        <ThemeSelect slug={slug} view={view} onChange={setView} />
        <ArtModeSelect slug={slug} view={view} onChange={setView} />
        {view.versions.length > 0 && <VersionPicker view={view} value={n} onPick={pick} label="Version" />}
        {v && (
          <button
            type="button"
            className={"btn" + (approved ? " primary" : "")}
            aria-pressed={approved}
            title={approved ? "Approved: this version goes into the handoff pack. Click to unapprove." : "Mark this version Approved (one per artifact): only approved versions go into the handoff pack"}
            onClick={() => void api.artifactUpdate(slug, id, { approvedVersion: approved ? 0 : v.n }).then(setView).catch((e) => ws.setError(String(e)))}
          >
            {approved ? "✓ Approved" : "Approve"}
          </button>
        )}
        {view.type === "theme" && (
          <button
            type="button"
            className="btn"
            disabled={view.isActiveTheme}
            onClick={() =>
              void api
                .artifactSetActiveTheme(slug, id)
                .then(() => api.artifactGet(slug, id))
                .then(setView)
                .catch((e) => ws.setError(String(e)))
            }
          >
            {view.isActiveTheme ? "Active theme" : "Set as active theme"}
          </button>
        )}
        {view.versions.length > 1 && (
          <button type="button" className={"btn" + (compare != null ? " primary" : "")} aria-pressed={compare != null} onClick={() => setCompare(compare != null ? null : view.versions.find((x) => x.n !== n)?.n ?? null)}>
            Compare
          </button>
        )}
      </div>
      {run && <RunBar run={run} />}
      {compare != null ? (
        <div className="artifact-compare">
          <section>
            <div className="artifact-compare-head">
              <VersionPicker view={view} value={n} onPick={setShown} label="Left version" />
            </div>
            <VersionBody slug={slug} view={view} v={v} stamp={stamp} />
          </section>
          <section>
            <div className="artifact-compare-head">
              <VersionPicker view={view} value={compare} onPick={setCompare} label="Right version" />
            </div>
            <VersionBody slug={slug} view={view} v={other} stamp={stamp} />
          </section>
        </div>
      ) : (
        <div className="artifact-full-main">
          <VersionBody slug={slug} view={view} v={v} stamp={stamp} big />
          <aside className="artifact-notes">
            {view.type === "theme" && v?.theme && <ThemeSpecView spec={v.theme} />}
            <h4>Brief</h4>
            {briefHtml ? <div className="md" dangerouslySetInnerHTML={{ __html: briefHtml }} /> : <p className="chat-sub">No brief.</p>}
            <h4>Design notes</h4>
            {notes ? <div className="md" dangerouslySetInnerHTML={{ __html: notes }} /> : <p className="chat-sub">No notes yet.</p>}
            {info?.meta && (
              <p className="chat-sub artifact-meta">
                {info.meta.model ? `${info.meta.model} · ` : ""}
                {typeof info.meta.credits === "number" ? `${info.meta.credits} credits` : ""}
                {info.meta.parent ? ` · from v${info.meta.parent}` : ""}
              </p>
            )}
          </aside>
        </div>
      )}
    </Modal>
  );
}

function ThemeSpecView({ spec }: { spec: NonNullable<ArtifactVersion["theme"]> }) {
  return (
    <div className="theme-spec">
      <div className="theme-swatches">
        {spec.palette.map((s) => (
          <span key={s.name} className="theme-swatch" title={`${s.name} ${s.hex}`}>
            <i style={{ background: s.hex }} />
            {s.name}
          </span>
        ))}
      </div>
      <p className="chat-sub">
        {[spec.fonts.heading && `Headings: ${spec.fonts.heading}`, spec.fonts.body && `Body: ${spec.fonts.body}`, spec.artMode && artModeLabel(spec.artMode)].filter(Boolean).join(" · ")}
      </p>
      {spec.mood.length > 0 && <p className="chat-sub">Mood: {spec.mood.join(", ")}</p>}
    </div>
  );
}

/** "Claude is working" with the SpriteCook job progress (indeterminate when unknown). */
export function RunBar({ run, compact }: { run: { label: string; progress: number | null; credits: number }; compact?: boolean }) {
  return (
    <div className={"artifact-run" + (compact ? " compact" : "")} role="status" aria-live="polite">
      <span className="artifact-run-label">
        {run.label}
        {run.credits > 0 ? ` · ${run.credits} cr` : ""}
      </span>
      <span className={"artifact-run-bar" + (run.progress == null ? " indeterminate" : "")}>
        <span style={run.progress != null ? { width: `${Math.round(Math.min(1, Math.max(0, run.progress)) * 100)}%` } : undefined} />
      </span>
    </div>
  );
}
