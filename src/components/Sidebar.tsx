import { useEffect, useRef, useState } from "react";
import { api, type ProjectSummary } from "../api";
import { Modal } from "../ui/Modal";
import { useTheme } from "../theme/ThemeContext";
import { IconFolder, IconInbox, IconPlus, IconTrash } from "./Icons";
import { ThemeEditor } from "./ThemeEditor";
import { ScrollArea } from "../ui/Scroll";

interface Props {
  projects: ProjectSummary[];
  active: string | null;
  onSelect: (slug: string) => void;
  onCreate: (name: string) => void;
  onDelete: (slug: string) => void;
}

export function Sidebar({ projects, active, onSelect, onCreate, onDelete }: Props) {
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const { themes, theme, setThemeId } = useTheme();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [editingTheme, setEditingTheme] = useState<{ initial: typeof theme; isNew: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) input.current?.focus();
  }, [naming]);

  const submit = () => {
    const n = name.trim();
    if (n) onCreate(n);
    setName("");
    setNaming(false);
  };

  return (
    <aside className="glass sidebar" aria-label="Projects" data-wheel-boundary="">
      <div className="wordmark">Dreamer</div>

      <div className="side-label">Projects</div>
      <ScrollArea as="nav" boundary className="side-section project-list" aria-label="Project list">
        {projects.map((p) => (
          <div key={p.slug} className={"side-row-wrap" + (p.slug === active ? " active" : "")}>
            <button
              className={"side-row" + (p.slug === active ? " active" : "")}
              type="button"
              aria-current={p.slug === active ? "true" : undefined}
              onClick={() => onSelect(p.slug)}
            >
              {p.is_inbox ? <IconInbox /> : <IconFolder />}
              <span>{p.name}</span>
              {p.is_inbox && p.card_count > 0 && (
                <span className="badge" aria-label={`${p.card_count} ideas`}>
                  {p.card_count}
                </span>
              )}
            </button>
            {!p.is_inbox && (
              <button type="button" className="icon-btn side-delete" aria-label={`Delete project ${p.name}`} title="Delete project" onClick={() => setDeleting(p)}>
                <IconTrash />
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
          {!theme.builtin && (
            <button type="button" className="chip" onClick={() => setEditingTheme({ initial: theme, isNew: false })}>Edit</button>
          )}
          <button type="button" className="chip" onClick={() => setEditingTheme({ initial: theme, isNew: true })}>New theme</button>
        </div>
      </div>

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

      {editingTheme && <ThemeEditor initial={editingTheme.initial} isNew={editingTheme.isNew} onClose={() => setEditingTheme(null)} />}

      {naming ? (
        <input
          ref={input}
          className="name-input"
          aria-label="New project name"
          placeholder="Project name, then Enter"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setName("");
              setNaming(false);
            }
          }}
          onBlur={submit}
        />
      ) : (
        <button className="new-project" type="button" onClick={() => setNaming(true)}>
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
        This removes the project&apos;s files from disk: its {n} card{n === 1 ? "" : "s"}, canvas, media, briefs, trash and chats.
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
