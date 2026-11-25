import { useState } from "react";
import { api } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";

/** What linking a folder writes there; shared by the "Link repo…" dialog and the handoff's first-use confirm. */
export function LinkRepoWrites() {
  return (
    <ul>
      <li><code>.dreamer/link.json</code>: the open version's cards (id, title, stage, build status), so Claude Code can name them.</li>
      <li><code>docs/design/STATUS.md</code>: created empty if missing. Claude Code writes build status there; Dreamer never edits it.</li>
    </ul>
  );
}

/** "Link repo…": pick the repo, confirm what Dreamer will write there, optionally git-ignore `.dreamer/`. */
export function LinkRepoDialog({ ws, slug, path, onClose }: { ws: Workspace; slug: string; path: string; onClose: () => void }) {
  const [ignore, setIgnore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setBusy(true);
    try {
      await api.linkRepo(slug, path, ignore);
      await ws.refresh();
      ws.toast("Repo linked.");
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="Link repo" size="sm">
      <div className="handoff-confirm">
        <p><strong>Link this repo?</strong></p>
        <code className="dialog-path">{path}</code>
        <LinkRepoWrites />
        <label className="check-row"><input type="checkbox" checked={ignore} onChange={(e) => setIgnore(e.target.checked)} /> Add <code>.dreamer/</code> to the repo's .gitignore</label>
        {error && <p className="setup-error" role="alert">{error}</p>}
        <div className="editor-actions">
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void link()}>Link</button>
        </div>
      </div>
    </Modal>
  );
}
