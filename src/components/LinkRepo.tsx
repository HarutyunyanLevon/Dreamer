import { useState } from "react";
import { api } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";

/** What linking a folder writes there; shared by the "Link repo…" dialog and the handoff's first-use confirm. */
export function LinkRepoWrites() {
  return (
    <ul>
      <li><code>docs/design/</code>: the design docs (and their images), replaced each time you generate the pack.</li>
      <li><code>CLAUDE.md</code>: only the block between the Dreamer markers; the rest of the file is left alone.</li>
    </ul>
  );
}

/** "Link repo…": pick the repo and confirm what Dreamer will write there. */
export function LinkRepoDialog({ ws, slug, path, onClose }: { ws: Workspace; slug: string; path: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setBusy(true);
    try {
      await api.linkRepo(slug, path);
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
