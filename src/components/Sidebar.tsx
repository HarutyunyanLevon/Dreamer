import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { api, type Folder, type ProjectSummary } from "../api";
import { cardVersions, folderName, isVersion, type Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";
import { useTheme } from "../theme/ThemeContext";
import { IconDoc, IconFolder, IconInbox, IconPlus, IconPower, IconTrash } from "./Icons";
import { ThemeEditor } from "./ThemeEditor";
import { ScrollArea } from "../ui/Scroll";

interface Props {
  projects: ProjectSummary[];
  active: string | null;
  onSelect: (slug: string) => void;
  /** Resolves to null on success, or the error text to show under the name field. */
  onCreate: (name: string) => Promise<string | null>;
  onDelete: (slug: string) => void;
  /** The active project's Design view (handoff pack versions) is open. */
  designOpen: boolean;
  onOpenDesign: () => void;
  /** The Memory modal is open for the active project. */
  memoryOpen: boolean;
  onOpenMemory: () => void;
  /** Pointer handlers of the width drag handle (usePanels().resize.left). */
  resize: HTMLAttributes<HTMLDivElement>;
  /** For the active project's folder tree. */
  ws: Workspace;
}

export function Sidebar({ projects, active, onSelect, onCreate, onDelete, designOpen, onOpenDesign, memoryOpen, onOpenMemory, resize, ws }: Props) {
  const tree = useFolderTree(ws);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const { themes, theme, setThemeId } = useTheme();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingTheme, setEditingTheme] = useState<{ initial: typeof theme; isNew: boolean } | null>(null);
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
              className={"side-row" + (p.slug === active ? " active" : "") + (p.slug === active && tree.over === "root" ? " drop-hover-ext" : "")}
              type="button"
              aria-current={p.slug === active && !ws.folder ? "true" : undefined}
              data-drop-folder={p.slug === active ? "root" : undefined}
              data-drop-project={p.slug}
              onClick={() => {
                if (p.slug !== active) return onSelect(p.slug);
                ws.setDesignOpen(false);
                ws.openFolder(null);
              }}
              {...(p.slug === active ? tree.dropProps(null) : {})}
            >
              {p.slug === active && tree.has ? (
                <span
                  className={"tree-chev" + (tree.collapsed.has(ROOT_KEY) ? "" : " open")}
                  role="button"
                  aria-label={tree.collapsed.has(ROOT_KEY) ? "Show folders" : "Hide folders"}
                  onClick={(e) => {
                    e.stopPropagation();
                    tree.toggle(ROOT_KEY);
                  }}
                >
                  ›
                </span>
              ) : null}
              {p.is_inbox ? <IconInbox /> : <IconFolder />}
              <span>{p.name}</span>
              {p.is_inbox && p.card_count > 0 && (
                <span className="badge" aria-label={`${p.card_count} ideas`}>
                  {p.card_count}
                </span>
              )}
            </button>
            {p.slug === active && tree.has && !tree.collapsed.has(ROOT_KEY) && <FolderRows tree={tree} ws={ws} parent={null} depth={1} />}
            {!p.is_inbox && (
              <button type="button" className="icon-btn side-delete" aria-label={`Delete project ${p.name}`} title="Delete project" onClick={() => setDeleting(p)}>
                <IconTrash />
              </button>
            )}
            {p.slug === active && !p.is_inbox && (
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
              <button
                type="button"
                className={"side-row side-sub" + (designOpen ? " active" : "")}
                aria-current={designOpen ? "true" : undefined}
                title="Design docs written from this project (handoff pack)"
                onClick={onOpenDesign}
              >
                <IconDoc />
                <span>Design</span>
                {(p.design_versions ?? 0) > 0 && (
                  <span className="badge" aria-label={`${p.design_versions} version${p.design_versions === 1 ? "" : "s"}`}>
                    {p.design_versions}
                  </span>
                )}
                {(p.open_questions ?? 0) > 0 && (
                  <span className="badge badge-alert" title="Unanswered questions from Claude Code" aria-label={`${p.open_questions} unanswered question${p.open_questions === 1 ? "" : "s"} from Claude Code`}>
                    {p.open_questions}?
                  </span>
                )}
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

      {api.kind === "tauri" && (
        <button
          type="button"
          className="side-quit"
          title="Quit Dreamer completely (closing the window keeps it in the tray)"
          onClick={() => void api.quitApp()}
        >
          <IconPower />
          Quit Dreamer
        </button>
      )}
    </aside>
  );
}

const ROOT_KEY = "__project";
const DRAG_TYPE = "application/x-dreamer-folder";

/** Collapse state (localStorage, per project) and drag-to-re-parent for the folder tree. */
function useFolderTree(ws: Workspace) {
  const slug = ws.active ?? "";
  const key = `dreamer.folderTree.${slug}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<string | null>(null);
  useEffect(() => {
    try {
      setCollapsed(new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]));
    } catch {
      setCollapsed(new Set());
    }
  }, [key]);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* storage unavailable: the tree just won't remember */
      }
      return next;
    });
  const d = ws.data;
  const folders: Folder[] = d?.folders ?? [];
  /** HTML drag of a folder row onto another folder (or the project row = the root). */
  const dropProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      setOver(target ?? "root");
    },
    onDragLeave: () => setOver((o) => (o === (target ?? "root") ? null : o)),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(DRAG_TYPE);
      setOver(null);
      if (!id || id === target) return;
      e.preventDefault();
      ws.reparentFolder(id, target);
    },
  });
  const inVersion = d ? cardVersions(d) : new Map<string, string>();
  /** Cards on a folder's canvas; for a version, every card in it. */
  const count = (id: string) => (isVersion(folders.find((f) => f.id === id)) ? [...inVersion.values()].filter((v) => v === id).length : Object.keys(d?.canvases[id]?.cards ?? {}).length);
  return { collapsed, toggle, folders, has: folders.length > 0, over, setOver, dropProps, count };
}

function FolderRows({ tree, ws, parent, depth }: { tree: ReturnType<typeof useFolderTree>; ws: Workspace; parent: string | null; depth: number }) {
  // Versions newest first, then ordinary folders by name.
  const kids = tree.folders
    .filter((f) => f.parent === parent)
    .sort((a, b) => Number(isVersion(b)) - Number(isVersion(a)) || (isVersion(a) ? b.created.localeCompare(a.created) : folderName(a).localeCompare(folderName(b))));
  if (!kids.length) return null;
  return (
    <div role="group">
      {kids.map((f) => {
        const hasKids = tree.folders.some((x) => x.parent === f.id);
        const open = !tree.collapsed.has(f.id);
        const n = tree.count(f.id);
        const ver = isVersion(f);
        return (
          <div key={f.id}>
            <button
              type="button"
              className={"side-row side-folder" + (ws.folder === f.id ? " active" : "") + (tree.over === f.id ? " drop-hover-ext" : "")}
              style={{ paddingLeft: 10 + depth * 12 }}
              aria-current={ws.folder === f.id ? "true" : undefined}
              aria-expanded={hasKids ? open : undefined}
              title={ver ? `Open version ${folderName(f)}` : `Open ${folderName(f)} · drag onto another folder to move it`}
              data-drop-folder={f.id}
              data-drop-project={ws.active ?? undefined}
              draggable={!ver}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, f.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => {
                ws.setDesignOpen(false);
                ws.openFolder(f.id);
              }}
              {...tree.dropProps(f.id)}
            >
              <span
                className={"tree-chev" + (open ? " open" : "") + (hasKids ? "" : " none")}
                role={hasKids ? "button" : undefined}
                aria-label={hasKids ? (open ? "Collapse" : "Expand") : undefined}
                onClick={(e) => {
                  if (!hasKids) return;
                  e.stopPropagation();
                  tree.toggle(f.id);
                }}
              >
                ›
              </span>
              {ver ? <span className="version-badge" aria-hidden="true">v</span> : <IconFolder />}
              <span>{folderName(f)}</span>
              {ver && <span className="sr-only"> (version)</span>}
              {n > 0 && <span className="badge" aria-label={`${n} card${n === 1 ? "" : "s"}`}>{n}</span>}
            </button>
            {hasKids && open && <FolderRows tree={tree} ws={ws} parent={f.id} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
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
        This removes the project&apos;s files from disk: its {n} card{n === 1 ? "" : "s"}, canvas, media, design versions, trash and chats.
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
