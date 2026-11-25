import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, taskReference, type Card, type HandoffEvent, type HandoffScope, type ProjectData, type SavedTask, type TaskFlag, type TaskKind } from "../api";
import { cardVersions, type Workspace } from "../state/useWorkspace";
import { STAGES } from "../theme/types";
import { Modal } from "../ui/Modal";
import { needsRebuild } from "../util/build";
import { renderDoc } from "../util/markdown";
import { LiveActivity, applyJobEvent, newJobActivity, type JobActivity } from "./Activity";
import { cardsInScope } from "./Handoff";
import { LinkRepoDialog } from "./LinkRepo";
import { buildRuns } from "../state/buildRuns";

/** The cards a scope builds: plain cards only (no stickies, labels, role cards or ghosts). A single card is just itself. */
export function taskCardIds(data: ProjectData, scope: HandoffScope): string[] {
  if (scope.kind === "card") return [scope.id];
  return cardsInScope(data, { scope, stages: [...STAGES], include_stickies: false })
    .filter((c) => c.kind === "card" && !c.role && !c.ghost)
    .map((c) => c.id);
}

/** Cards of the open version waiting for Claude Code (`queued`) or built but changed since (`needs rebuild`). */
export function batchIds(data: ProjectData, which: "queued" | "rebuild"): string[] {
  const of = cardVersions(data);
  const open = data.meta.last_version;
  return data.cards
    .filter((c) => c.kind === "card" && !c.role && !c.ghost && (!open || of.get(c.id) === open))
    .filter((c) => (which === "queued" ? c.build?.status === "queued" : needsRebuild(c)))
    .map((c) => c.id);
}

interface Made {
  slug: string;
  markdown: string;
  title: string;
  cardIds: string[];
  flags: TaskFlag[];
  model: string;
  version: string;
  kind: TaskKind;
}
interface Running {
  slug: string;
  activity: JobActivity;
  error: string | null;
}

/** "Make build prompt": the progress panel, then the editable preview with its hand-over buttons. */
export function TaskHost({ ws }: { ws: Workspace }) {
  const [run, setRun] = useState<Running | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const job = useRef<string | null>(null);
  const { taskRequest, clearTask, refresh } = ws;

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    api
      .onHandoffEvent((e: HandoffEvent) => {
        // The first event can arrive before taskStart resolves with the id.
        if (job.current !== e.job && job.current !== "pending") return;
        if (job.current === "pending") job.current = e.job;
        if (e.type === "done" && e.mode === "task") {
          job.current = null;
          setRun((r) => {
            if (r) setMade({ slug: r.slug, markdown: e.markdown, title: e.title, cardIds: e.card_ids, flags: e.flags, model: e.model, version: e.version, kind: e.kind });
            return null;
          });
        } else if (e.type === "error") {
          job.current = null;
          setRun((r) => (r ? { ...r, error: e.message } : r));
        } else setRun((r) => (r ? { ...r, activity: applyJobEvent(r.activity, e) } : r));
      })
      .then((u) => (gone ? u() : (un = u)))
      .catch(() => {});
    return () => {
      gone = true;
      un?.();
    };
  }, []);

  const begin = useCallback(
    async (slug: string, ids: string[]) => {
      job.current = "pending";
      setMade(null);
      setRun({ slug, activity: newJobActivity(), error: null });
      try {
        job.current = await api.taskStart(slug, ids);
      } catch (e) {
        job.current = null;
        setRun(null);
        ws.setError(String(e));
      }
    },
    [ws],
  );

  useEffect(() => {
    if (!taskRequest) return;
    clearTask();
    if (!ws.active || !ws.data) return;
    const ids = taskCardIds(ws.data, taskRequest.scope);
    if (!ids.length) ws.toast("There are no cards to build here (only plain cards count).");
    else void begin(ws.active, ids);
  }, [taskRequest, clearTask, ws, begin]);

  const cancel = () => {
    job.current = null;
    setRun(null);
    void api.handoffCancel().catch((e) => ws.setError(String(e)));
    ws.toast("Cancelled.");
  };

  return (
    <>
      {run && (
        <section className="glass handoff-progress" aria-label="Build prompt progress" aria-live="polite" data-wheel-boundary="">
          <div className="handoff-progress-head">
            <div className="orb small" aria-hidden="true" />
            <strong>{run.error ? "The build prompt failed" : "Writing the build prompt"}</strong>
          </div>
          {!run.error && (
            <div className="handoff-activity scroll scroll-y">
              <LiveActivity steps={run.activity.steps} usage={run.activity.usage} startedAt={run.activity.startedAt} lastEventAt={run.activity.lastEventAt} />
            </div>
          )}
          {run.error && <p className="setup-error" role="alert">{run.error}</p>}
          <div className="editor-actions">
            <div className="side-spacer" />
            {run.error ? (
              <button type="button" className="btn" onClick={() => setRun(null)}>Close</button>
            ) : (
              <button type="button" className="btn" onClick={cancel} title="Stop Claude; nothing is written">Cancel</button>
            )}
          </div>
        </section>
      )}
      {made && <TaskPreview ws={ws} made={made} onClose={() => setMade(null)} onSaved={() => void refresh()} />}
    </>
  );
}

function TaskPreview({ ws, made, onClose, onSaved }: { ws: Workspace; made: Made; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(made.markdown);
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const cards = made.cardIds.map((id) => ws.data?.cards.find((c) => c.id === id)).filter((c): c is Card => !!c);
  const html = useMemo(() => (preview ? renderDoc(text) : ""), [preview, text]);
  const linked = !!ws.data?.meta.handoff_target && ws.data.meta.handoff_target_confirmed === ws.data.meta.handoff_target;
  const cardTitle = (id?: string | null) => (id && ws.data?.cards.find((c) => c.id === id)?.title) || null;
  const fail = (e: unknown) => ws.setError(String(e));

  /** Saves (once) and returns the repo-relative path; null when it needs a repo first or failed. */
  const save = async (): Promise<string | null> => {
    if (saved) return saved;
    if (!linked) {
      void api.pickFolder("Repo folder").then((p) => p && setLinking(p), fail);
      ws.toast("Link a repo first, then save the task.");
      return null;
    }
    setBusy(true);
    try {
      const file = await api.saveTask(made.slug, { markdown: text, title: made.title, card_ids: made.cardIds, kind: made.kind, version: made.version });
      setSaved(file);
      onSaved();
      ws.toast(`Saved ${file}.`);
      return file;
    } catch (e) {
      fail(e);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(saved ? taskReference(saved) : text);
      ws.toast(saved ? "Copied the short reference." : "Copied the full task.");
    } catch (e) {
      fail(`Couldn't copy: ${String(e)}`);
    }
  };

  const terminal = async () => {
    const file = await save();
    if (!file) return;
    try {
      await api.openTerminal(made.slug, file);
    } catch (e) {
      ws.toast(String(e).replace(/^Error: /, ""));
    }
  };

  return (
    <>
      <Modal onClose={onClose} label="Build prompt" size="lg" placement="canvas" className="design-view task-preview">
        <div className="design-head">
          <h3 className="dialog-title">{made.title}</h3>
          <div className="side-spacer" />
          <span className="chat-sub">{made.kind === "rebuild" ? "Rebuild" : "Build"}{made.version ? ` · ${made.version}` : ""} · {made.model}</span>
        </div>
        <div className="task-chips">
          {cards.map((c) => (
            <button key={c.id} type="button" className="chip" title="Open this card" onClick={() => void ws.focusCard(c.id)}>{c.title}</button>
          ))}
        </div>
        {made.flags.length > 0 && (
          <ul className="task-flags" aria-label="Thin spots">
            {made.flags.map((f, i) => {
              const t = cardTitle(f.card_id);
              return (
                <li key={i}>
                  <span>{t ? <strong>{t}: </strong> : null}{f.text}</span>
                  {f.card_id && t && (
                    <span className="task-flag-actions">
                      <button type="button" className="chip" onClick={() => void ws.focusCard(f.card_id!)}>Open card</button>
                      <button
                        type="button"
                        className="chip"
                        title="Run /grill-me on this card in its thread"
                        onClick={() => {
                          ws.setContextCard(f.card_id!);
                          ws.requestChat({ text: "/grill-me", thread: f.card_id!, send: true });
                        }}
                      >
                        Grill this card
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="seg" role="group" aria-label="Editor or preview">
          <button type="button" className={"chip" + (!preview ? " on" : "")} aria-pressed={!preview} onClick={() => setPreview(false)}>Edit</button>
          <button type="button" className={"chip" + (preview ? " on" : "")} aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
        </div>
        {preview ? (
          <div className="design-body doc task-body" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <textarea
            className="task-edit"
            aria-label="Task markdown"
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(null);
            }}
          />
        )}
        {saved && <p className="chat-sub">Saved as <code>{saved}</code>. Editing the text and saving again writes a new file.</p>}
        <div className="editor-actions design-actions">
          <button type="button" className="btn" onClick={() => void copy()} title={saved ? taskReference(saved) : "The whole task"}>{saved ? "Copy reference" : "Copy"}</button>
          <button type="button" className="btn" disabled={busy || !!saved} onClick={() => void save()}>{saved ? "Saved" : "Save task"}</button>
          <button type="button" className="btn" disabled={busy} title="Save, then let Claude Code build it here on a new branch" onClick={() => void save().then((f) => { if (f) { buildRuns.requestStart(made.slug, [f]); onClose(); } })}>Run in Dreamer</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void terminal()}>Open terminal</button>
          <div className="side-spacer" />
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        </div>
      </Modal>
      {linking && <LinkRepoDialog ws={ws} slug={made.slug} path={linking} onClose={() => setLinking(null)} />}
    </>
  );
}

/** The Design view's "Tasks" list: saved tasks of the linked repo, and the batch prompts. */
export function TasksPanel({ ws }: { ws: Workspace }) {
  const slug = ws.active!;
  const [tasks, setTasks] = useState<SavedTask[] | null>(null);
  const [tick, setTick] = useState(0);
  const { setError } = ws;
  useEffect(() => {
    let live = true;
    api.listTasks(slug).then((t) => live && setTasks(t), (e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [slug, tick, setError]);
  const queued = ws.data ? batchIds(ws.data, "queued") : [];
  const rebuild = ws.data ? batchIds(ws.data, "rebuild") : [];
  const open = (file: string) => void api.openRepoFile(slug, file, false).catch((e) => ws.setError(String(e)));
  const copy = (file: string) => navigator.clipboard.writeText(taskReference(file)).then(() => ws.toast("Copied the short reference."), () => ws.toast("Could not copy."));
  const done = (file: string) => void api.markTaskDone(slug, file).then(() => setTick((n) => n + 1), (e) => ws.setError(String(e)));
  return (
    <div className="design-body tasks-panel">
      <div className="task-batch">
        <button type="button" className="btn" disabled={!queued.length} onClick={() => ws.openTask({ kind: "selection", ids: queued })}>Prompt for queued ({queued.length})</button>
        <button type="button" className="btn" disabled={!rebuild.length} onClick={() => ws.openTask({ kind: "selection", ids: rebuild })}>Prompt for needs rebuild ({rebuild.length})</button>
      </div>
      {tasks === null ? (
        <p className="chat-sub">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="chat-sub">No saved tasks. Use “Make build prompt” on a card, a selection, a frame or a version, then Save task (needs a linked repo).</p>
      ) : (
        <ul className="task-list">
          {tasks.map((t) => (
            <li key={t.file} className={t.done ? "done" : undefined}>
              <div>
                <strong>{t.title}</strong>
                <div className="chat-sub">
                  {t.kind} · {t.cards.length} card{t.cards.length === 1 ? "" : "s"} · {new Date(t.created).toLocaleDateString()}
                  {t.version ? ` · ${t.version}` : ""}
                  {t.done ? " · done" : ""}
                </div>
              </div>
              <div className="task-flag-actions">
                <button type="button" className="chip" onClick={() => open(t.file)}>Open</button>
                <button type="button" className="chip" onClick={() => void copy(t.file)}>Copy</button>
                <button type="button" className="chip" title="Claude Code builds it here on a new branch" onClick={() => buildRuns.requestStart(slug, [t.file])}>Run</button>
                <button type="button" className="chip" disabled={!!t.done} onClick={() => done(t.file)}>Mark done</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
