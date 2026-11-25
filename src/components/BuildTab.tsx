import { useEffect, useState } from "react";
import { api, type Card } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { evidencePath, needsRebuild, STATUS_LABEL } from "../util/build";
import { diffLines } from "../util/diff";
import { useMediaUrl } from "../util/media";

const when = (at?: string) => (at ? new Date(at).toLocaleString() : "");
/** `task:` is relative to docs/design; anything already rooted in the repo is left alone. */
const taskPath = (t: string) => (/^(docs|\.dreamer)\//.test(t) ? t : `docs/design/${t.replace(/^\.?\//, "")}`);

/** What Claude Code built for this card (the card editor's "Build" tab). */
export function BuildTab({ card, ws }: { card: Card; ws: Workspace }) {
  const b = card.build ?? {};
  const slug = ws.active;
  const dirty = needsRebuild(card);
  const [diff, setDiff] = useState<{ snapshot: string | null; current: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const hasSnapshot = !!b.snapshot_hash;

  useEffect(() => {
    if (!showDiff || !slug) return;
    let off = false;
    api.buildTexts(slug, card.id).then((d) => !off && setDiff(d), (e) => ws.setError(String(e)));
    return () => {
      off = true;
    };
  }, [showDiff, slug, card.id, card.updated, ws]);

  const open = (rel: string, reveal = false) => {
    if (slug) void api.openRepoFile(slug, rel, reveal).catch((e) => ws.setError(String(e)));
  };
  const copy = (hash: string) => {
    navigator.clipboard?.writeText(hash).then(() => ws.toast(`Copied ${hash}.`), () => ws.toast("Could not copy."));
  };

  return (
    <div className="build-tab">
      <div className="editor-row">
        <span className="side-label">Status</span>
        <div className="build-status-row">
          <span className={`status-pill ${b.status ?? ""}`}>{STATUS_LABEL[b.status ?? ""] ?? b.status ?? "Unknown"}</span>
          {dirty && <span className="rebuild-pill">Needs rebuild</span>}
          {b.built_at && <span className="helper">built {when(b.built_at)}</span>}
        </div>
        {b.status === "blocked" && <div className="build-blocked">{b.notes || "Claude Code is blocked on this card. See the From Claude Code questions."}</div>}
        {!!b.history?.length && (
          <ul className="build-history" aria-label="Status history">
            {[...b.history].reverse().slice(0, 8).map((h, i) => (
              <li key={i}>
                {STATUS_LABEL[h.status] ?? h.status} · {h.source} · {when(h.at)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {b.task && (
        <div className="editor-row">
          <span className="side-label">Task</span>
          <div className="build-item">
            <code>{b.task}</code>
            <button type="button" className="chip" onClick={() => open(taskPath(b.task!))}>Open</button>
          </div>
        </div>
      )}

      {!!b.commits?.length && (
        <div className="editor-row">
          <span className="side-label">Commits</span>
          <div className="build-list">
            {b.commits.map((h) => (
              <div key={h} className="build-item">
                <code>{h}</code>
                <button type="button" className="chip" onClick={() => copy(h)}>Copy</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!!b.files?.length && (
        <div className="editor-row">
          <span className="side-label">Files</span>
          <div className="build-list">
            {b.files.map((f) => (
              <div key={f} className="build-item">
                <code title={f}>{f}</code>
                <button type="button" className="chip" title="Open in VS Code, or show in the file manager if `code` is not installed" onClick={() => open(f)}>Open</button>
                <button type="button" className="chip" onClick={() => open(f, true)}>Show</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!!b.evidence?.length && (
        <div className="editor-row">
          <span className="side-label">Evidence</span>
          <div className="evidence-grid">
            {b.evidence.map((e) => (
              <Evidence key={evidencePath(e)} slug={slug} path={evidencePath(e)} repo={typeof e === "string" ? undefined : e.repo} onOpen={open} />
            ))}
          </div>
        </div>
      )}

      {b.notes && b.status !== "blocked" && (
        <div className="editor-row">
          <span className="side-label">Notes</span>
          <p className="helper" style={{ whiteSpace: "pre-wrap" }}>{b.notes}</p>
        </div>
      )}

      <div className="editor-row">
        <div className="editor-row-head">
          <span className="side-label">Diff since built</span>
          <button type="button" className="chip" disabled={!hasSnapshot} title={hasSnapshot ? undefined : "There is no snapshot of this card yet"} onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Hide" : "Show"}
          </button>
        </div>
        {showDiff &&
          (diff?.snapshot == null ? (
            <p className="helper">{diff ? "No snapshot of this card yet." : "Loading…"}</p>
          ) : (
            <div className="build-diff" role="region" aria-label="Changes since the card was built">
              {diffLines(diff.snapshot, diff.current).map((l, i) => (
                <div key={i} className={l.kind === "same" ? undefined : l.kind}>
                  {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}
                  {l.text}
                </div>
              ))}
            </div>
          ))}
      </div>

      <div className="editor-row">
        <button type="button" className="btn" title="The card as saved now becomes the built version" onClick={() => void ws.markBuiltNow(card.id)}>
          {dirty ? "Clear needs rebuild" : "Mark as built now"}
        </button>
      </div>
    </div>
  );
}

function Evidence({ slug, path, repo, onOpen }: { slug: string | null; path: string; repo?: string; onOpen: (rel: string) => void }) {
  const url = useMediaUrl(slug, path, 1600);
  if (!url) return <div className="helper" title={path}>…</div>;
  return <img src={url} alt={repo ?? "Build evidence"} title={repo} loading="lazy" onClick={() => repo && onOpen(repo)} />;
}
