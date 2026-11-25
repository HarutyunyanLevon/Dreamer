import { useEffect, useMemo, useRef, useState } from "react";
import { api, DESIGN_DOCS, type DesignVersion } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";
import { ScrollArea } from "../ui/Scroll";
import { renderDoc } from "../util/markdown";
import { TasksPanel } from "./TaskPrompt";

/** What "Copy Claude Code prompt" puts on the clipboard. */
export const CLAUDE_CODE_PROMPT = "Read CLAUDE.md and docs/design/, then implement 03-roadmap.md starting at the first unchecked task. Commit per task.";

const TAB_LABEL: Record<string, string> = {
  "00-overview.md": "Overview",
  "01-gdd.md": "GDD",
  "02-tech-design.md": "Tech design",
  "03-roadmap.md": "Roadmap",
  "04-open-questions.md": "Open questions",
  "05-assets.md": "Assets",
  "CLAUDE.md": "CLAUDE.md",
  "CHANGELOG.md": "Changelog",
};

/**
 * Reader for the project's handoff pack versions (design/v<N>/): one tab per doc, rendered
 * markdown with the version's images, a version picker and the hand-over actions.
 */
export function DesignView({ ws, onClose, onNewVersion }: { ws: Workspace; onClose: () => void; onNewVersion: () => void }) {
  const slug = ws.active!;
  const count = ws.projects.find((p) => p.slug === slug)?.design_versions ?? 0;
  const [versions, setVersions] = useState<DesignVersion[] | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  /** The project version's folder under design/ ("" = the flat design/v<N>/ layout). */
  const [dir, setDir] = useState("");
  const [doc, setDoc] = useState<string>(DESIGN_DOCS[0]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const bodyRef = useRef<HTMLElement | null>(null);
  const pendingHash = useRef<string | null>(null);
  const images = useRef(new Map<string, string>());

  // (Re)load the version list for this project; a new version (count changed) is shown at once.
  useEffect(() => {
    let live = true;
    api
      .listDesignVersions(slug)
      .then((v) => {
        if (!live) return;
        setVersions(v);
        // The open project version's newest revision, else the newest of all.
        const open = ws.data?.meta.last_version;
        const pick = [...v].reverse().find((e) => open && e.version_id === open) ?? v[v.length - 1];
        setDir(pick?.dir ?? "");
        setVersion(pick ? pick.version : null);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [slug, count]);

  const entry = versions?.find((v) => v.version === version && (v.dir ?? "") === dir) ?? null;
  const groups = [...new Map((versions ?? []).map((v) => [v.dir ?? "", v.version_title || v.dir || ""])).entries()];
  const revisions = (versions ?? []).filter((v) => (v.dir ?? "") === dir);
  const revLabel = (n: number) => (dir ? `r${n}` : `v${n}`);
  const base = dir ? `design/${dir}/r${version}` : `design/v${version}`;
  const docs = entry ? DESIGN_DOCS.filter((d) => entry.docs.length === 0 || entry.docs.includes(d)) : [];

  useEffect(() => {
    if (version === null) return;
    let live = true;
    setText(null);
    setError(null);
    api
      .readDesignDoc(slug, version, doc, dir)
      .then((t) => live && setText(t))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [slug, version, doc, dir]);

  const html = useMemo(() => (text === null ? "" : renderDoc(text)), [text]);

  // Fill in the images (from design/v<N>/assets/) and jump to a pending #anchor.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || version === null) return;
    let live = true;
    root.querySelectorAll<HTMLImageElement>("img[data-asset]").forEach((img) => {
      const rel = `${base}/${img.dataset.asset}`;
      const key = `${slug}/${rel}`;
      const cached = images.current.get(key);
      if (cached) {
        img.src = cached;
        return;
      }
      api
        .readMedia(slug, rel)
        .then((url) => {
          images.current.set(key, url);
          if (live) img.src = url;
        })
        .catch(() => {
          if (live) img.replaceWith(Object.assign(document.createElement("span"), { className: "doc-noimg", textContent: `[missing image: ${img.alt || img.dataset.asset}]` }));
        });
    });
    const hash = pendingHash.current;
    pendingHash.current = null;
    if (hash) requestAnimationFrame(() => root.querySelector(`[id="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: "start" }));
    else root.scrollTo({ top: 0 });
    return () => {
      live = false;
    };
  }, [html, slug, version, base]);

  const onBodyClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.external !== undefined) {
      void api.openUrl(a.getAttribute("href") ?? "").catch((err) => ws.setError(String(err)));
      return;
    }
    const target = a.dataset.doc || doc;
    const hash = a.dataset.hash || null;
    if (target === doc) {
      if (hash) bodyRef.current?.querySelector(`[id="${CSS.escape(hash)}"]`)?.scrollIntoView({ block: "start" });
    } else if ((DESIGN_DOCS as readonly string[]).includes(target)) {
      pendingHash.current = hash;
      setDoc(target);
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(CLAUDE_CODE_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      ws.setError(`Couldn't copy: ${String(e)}`);
    }
  };

  const discuss = () => {
    ws.setContextCard(null);
    ws.requestChat({ thread: null, text: `About the design doc ${doc} (design ${dir ? `${groups.find((g) => g[0] === dir)?.[1]} ` : ""}${revLabel(version ?? 0)}): ` });
  };

  return (
    <Modal onClose={onClose} label="Design" size="lg" placement="canvas" className="design-view">
      <div className="design-head">
        <h3 className="dialog-title">Design</h3>
        {groups.length > 1 && (
          <label className="design-version">
            <span className="sr-only">Project version</span>
            <select
              value={dir}
              onChange={(e) => {
                const last = (versions ?? []).filter((v) => (v.dir ?? "") === e.target.value).pop();
                setDir(e.target.value);
                setVersion(last ? last.version : null);
              }}
            >
              {groups.map(([d, t]) => (
                <option key={d} value={d}>{t || "Before versions"}</option>
              ))}
            </select>
          </label>
        )}
        {versions && versions.length > 0 && (
          <label className="design-version">
            <span className="sr-only">Revision</span>
            <select value={version ?? ""} onChange={(e) => setVersion(Number(e.target.value))}>
              {[...revisions].reverse().map((v) => (
                <option key={v.version} value={v.version}>
                  {revLabel(v.version)} · {new Date(v.created).toLocaleDateString()} · {v.scope}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="side-spacer" />
        <button type="button" className={"btn" + (showTasks ? " on" : "")} aria-pressed={showTasks} onClick={() => setShowTasks((v) => !v)} title="Build tasks saved in the linked repo">Tasks</button>
        <button type="button" className="btn" onClick={onNewVersion}>New version</button>
      </div>
      {showTasks && <TasksPanel ws={ws} />}

      {!showTasks && versions && versions.length === 0 && (
        <div className="design-empty">
          <p>No design versions yet.</p>
          <p className="chat-sub">Summarize the project to write the first handoff pack: an overview, a game design document, a tech design, a roadmap Claude Code can work through, open questions, assets and a CLAUDE.md.</p>
        </div>
      )}

      {entry && !showTasks && (
        <>
          <div className="design-tabs" role="tablist" aria-label="Documents">
            {docs.map((d) => (
              <button key={d} type="button" role="tab" aria-selected={d === doc} className={"chip" + (d === doc ? " on" : "")} title={d} onClick={() => setDoc(d)}>
                {TAB_LABEL[d] ?? d}
              </button>
            ))}
          </div>
          <ScrollArea boundary className="design-body" ref={bodyRef} role="tabpanel" aria-label={doc} onClick={onBodyClick}>
            {error ? <p className="setup-error">{error}</p> : text === null ? <p className="chat-sub">Loading…</p> : <div className="doc" dangerouslySetInnerHTML={{ __html: html }} />}
          </ScrollArea>
          <div className="editor-actions design-actions">
            <button type="button" className="btn" onClick={() => void api.openDesignFolder(slug, entry.version, entry.dir).catch((e) => ws.setError(String(e)))}>Open folder</button>
            <button type="button" className="btn" onClick={() => void copyPrompt()} title={CLAUDE_CODE_PROMPT}>{copied ? "Copied" : "Copy Claude Code prompt"}</button>
            <button type="button" className="btn" onClick={discuss} title="Open the project chat about this document">Discuss with Claude</button>
            <div className="side-spacer" />
            <span className="chat-sub">{entry.cards} cards · {entry.model}</span>
            <button type="button" className="btn primary" onClick={onClose}>Close</button>
          </div>
        </>
      )}
      {(!entry || showTasks) && (
        <div className="editor-actions">
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      )}
    </Modal>
  );
}
