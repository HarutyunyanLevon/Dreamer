import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { api, type ProjectSummary } from "../api";
import { type Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";
import { useTheme } from "../theme/ThemeContext";
import { IconDoc, IconFolder, IconPlus, IconTrash } from "./Icons";
import { pickBundle } from "./Import";
import { LinkRepoDialog } from "./LinkRepo";
import { ScrollArea } from "../ui/Scroll";

interface Props {
  projects: ProjectSummary[];
  active: string | null;
  onSelect: (slug: string) => void;
  /** Resolves to null on success, or the error text to show under the name field. */
  onCreate: (name: string) => Promise<string | null>;
  onDelete: (slug: string) => void;
  /** The Memory modal is open for the active project. */
  memoryOpen: boolean;
  onOpenMemory: () => void;
  /** Pointer handlers of the width drag handle (usePanels().resize.left). */
  resize: HTMLAttributes<HTMLDivElement>;
  ws: Workspace;
}

export function Sidebar({ projects, active, onSelect, onCreate, onDelete, memoryOpen, onOpenMemory, resize, ws }: Props) {
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const { themes, theme, setThemeId } = useTheme();
  const [linking, setLinking] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /**
   * Set once this naming session is finished (submitted or cancelled). Enter, then the blur that
   * follows when the field unmounts or loses focus, must not create the project twice. A ref,
   * because a blur handler can run with the closure of an older render.
   */
  const done = useRef(false);
  const nameRef = useRef("");
  nameRef.current = name;

  useEffect(() => {
    if (naming) input.current?.focus();
  }, [naming]);

  const startNaming = () => {
    done.current = false;
    setName("");
    setCreateError(null);
    setNaming(true);
  };
  const cancel = () => {
    done.current = true;
    setName("");
    setCreateError(null);
    setNaming(false);
  };
  /** Enter creates. Leaving the field with a name typed also creates; leaving it empty cancels. */
  const submit = async (via: "enter" | "blur") => {
    if (done.current) return;
    const n = nameRef.current.trim();
    if (!n) {
      if (via === "blur") cancel();
      return;
    }
    done.current = true;
    setCreating(true);
    const err = await onCreate(n);
    setCreating(false);
    if (err) {
      // Keep the field open with the name, show why, and allow another try.
      done.current = false;
      setCreateError(err);
      requestAnimationFrame(() => input.current?.focus());
      return;
    }
    setName("");
    setCreateError(null);
    setNaming(false);
  };

  return (
    <aside id="projects-panel" className="glass sidebar" aria-label="Projects" data-wheel-boundary="">
      <div className="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize projects panel" title="Drag to resize, double-click to reset" {...resize} />
      <div className="wordmark">Dreamer</div>

      <div className="side-label">Projects</div>
      <ScrollArea as="nav" boundary className="side-section project-list" aria-label="Project list">
        {projects.map((p) => (
          <div key={p.slug} className={"side-row-wrap" + (p.slug === active ? " active" : "")}>
            <button
              className={"side-row" + (p.slug === active ? " active" : "")}
              type="button"
              aria-current={p.slug === active ? "true" : undefined}
              onClick={() => p.slug !== active && onSelect(p.slug)}
            >
              <IconFolder />
              <span>{p.name}</span>
            </button>
            {projects.length > 1 && (
              <button type="button" className="icon-btn side-delete" aria-label={`Delete project ${p.name}`} title="Delete project" onClick={() => setDeleting(p)}>
                <IconTrash />
              </button>
            )}
            {p.slug === active && (
              <button
                type="button"
                className={"side-row side-sub" + (memoryOpen ? " active" : "")}
                aria-current={memoryOpen ? "true" : undefined}
                title="What Dreamer remembers about this project (read by Claude, kept up to date from your decisions)"
                onClick={onOpenMemory}
              >
                <IconDoc />
                <span>Memory</span>
              </button>
            )}
            {p.slug === active && (
              <button type="button" className="side-row side-sub" title="Add cards from a .dreamer.md bundle (or paste one on the canvas)" onClick={() => pickBundle()}>
                <IconDoc />
                <span>Import bundle…</span>
              </button>
            )}
            {p.slug === active && (
              <button
                type="button"
                className="side-row side-sub"
                title={ws.data?.meta.handoff_target ? `Repo: ${ws.data.meta.handoff_target}. Pick another folder to change it.` : "Link a code repo: the design pack is written into it"}
                onClick={() => void api.pickFolder("Repo folder").then((path) => path && setLinking(path), (e) => ws.setError(String(e)))}
              >
                <IconFolder />
                <span>{ws.data?.meta.handoff_target ? "Repo…" : "Link repo…"}</span>
              </button>
            )}
          </div>
        ))}
      </ScrollArea>

      <div className="side-section">
        <div className="side-label">Theme</div>
        <div className="theme-row" role="radiogroup" aria-label="Theme">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === theme.id}
              aria-label={t.name}
              title={t.name}
              className={"swatch" + (t.id === theme.id ? " on" : "")}
              onClick={() => setThemeId(t.id)}
              style={{
                background: `linear-gradient(135deg, ${t.shader.palette[0]}, ${t.shader.palette[1]} 45%, ${t.shader.palette[3]})`,
              }}
            />
          ))}
        </div>
        <div className="theme-name-row">
          <div className="theme-name">{theme.name}</div>
        </div>
      </div>

      {linking && active && <LinkRepoDialog ws={ws} slug={active} path={linking} onClose={() => setLinking(null)} />}
      {deleting && (
        <DeleteProjectDialog
          project={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            onDelete(deleting.slug);
            setDeleting(null);
          }}
        />
      )}

      {naming ? (
        <div className="name-field">
          <input
            ref={input}
            className="name-input"
            aria-label="New project name"
            aria-invalid={createError ? true : undefined}
            aria-describedby={createError ? "new-project-error" : undefined}
            placeholder="Project name, then Enter"
            value={name}
            maxLength={120}
            readOnly={creating}
            onChange={(e) => {
              setName(e.target.value);
              if (createError) setCreateError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit("enter");
              }
              if (e.key === "Escape") {
                e.stopPropagation();
                cancel();
              }
            }}
            onBlur={() => void submit("blur")}
          />
          {createError && (
            <p id="new-project-error" className="side-error" role="alert">
              {createError}
            </p>
          )}
        </div>
      ) : (
        <button className="new-project" type="button" onClick={startNaming}>
          <IconPlus />
          New project
        </button>
      )}

    </aside>
  );
}

/** "Are you sure?" for deleting a project. Says plainly that the folder leaves the disk. */
function DeleteProjectDialog({ project, onCancel, onConfirm }: { project: ProjectSummary; onCancel: () => void; onConfirm: () => void }) {
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    api.workspaceInfo().then((w) => setRoot(w.root)).catch(() => {});
  }, []);
  const sep = root?.includes("\\") ? "\\" : "/";
  const folder = root ? `${root}${sep}projects${sep}${project.slug}` : `projects/${project.slug}`;
  const n = project.card_count;
  return (
    <Modal onClose={onCancel} label={`Delete project ${project.name}`} size="sm">
      <h3 className="dialog-title">Delete “{project.name}”?</h3>
      <p>
        This removes the project&apos;s files from disk: its {n} card{n === 1 ? "" : "s"}, canvas, media, design docs, trash and chats.
      </p>
      <code className="dialog-path">{folder}</code>
      <p className="chat-sub">The folder is moved to the Recycle Bin, where you can restore it. If that isn&apos;t possible, it is deleted permanently. This can&apos;t be undone from inside Dreamer.</p>
      <div className="editor-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={onCancel} autoFocus>Cancel</button>
        <button type="button" className="btn danger" onClick={onConfirm}>Delete project</button>
      </div>
    </Modal>
  );
}
