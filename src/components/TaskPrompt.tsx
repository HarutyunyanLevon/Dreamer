import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, taskReference, type Card, type FlagAnswers, type HandoffEvent, type HandoffScope, type ProjectData, type SavedTask, type TaskFlag, type TaskKind, type TaskRevise } from "../api";
import { type Workspace } from "../state/useWorkspace";
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

/** Cards waiting for Claude Code (`queued`) or built but changed since (`needs rebuild`). */
export function batchIds(data: ProjectData, which: "queued" | "rebuild"): string[] {
  return data.cards
    .filter((c) => c.kind === "card" && !c.role && !c.ghost)
    .filter((c) => (which === "queued" ? c.build?.status === "queued" : needsRebuild(c)))
    .map((c) => c.id);
}

interface Made {
  /** Remounts the preview for every new prompt. */
  n: number;
  slug: string;
  markdown: string;
  title: string;
  cardIds: string[];
  flags: TaskFlag[];
  model: string;
  version: string;
  kind: TaskKind;
  /** Decisions already made (a reopened saved task). */
  answers?: FlagAnswers;
}
type TaskDone = Extract<HandoffEvent, { type: "done"; mode: "task" }>;

/** Runs a task job outside TaskHost's progress panel and resolves with its result. */
async function runTask(slug: string, ids: string[], model?: string, revise?: TaskRevise): Promise<TaskDone> {
  let id: string | null = null;
  const early: HandoffEvent[] = [];
  let settle: (e: HandoffEvent) => void = () => {};
  const end = new Promise<HandoffEvent>((r) => (settle = r));
  const un = await api.onHandoffEvent((e) => {
    if (e.type !== "done" && e.type !== "error") return;
    // The result can arrive before taskStart resolves with the id.
    if (id === null) early.push(e);
    else if (e.job === id) settle(e);
  });
  try {
    id = await api.taskStart(slug, ids, model, revise);
    early.filter((e) => e.job === id).forEach(settle);
    const e = await end;
    if (e.type === "error") throw new Error(e.message);
    if (e.type === "done" && e.mode === "task") return e;
    throw new Error("Unexpected result.");
  } finally {
    un();
  }
}

const question = (f: TaskFlag) => f.question?.trim() || f.text;
const includeLabel = (title: string) => `Include "${title}" in this build`;
const trimmed = (a: FlagAnswers) => Object.fromEntries(Object.entries(a).flatMap(([k, v]) => (v.trim() ? [[k, v.trim()]] : [])));
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
  const seq = useRef(0);
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
            if (r) setMade({ n: ++seq.current, slug: r.slug, markdown: e.markdown, title: e.title, cardIds: e.card_ids, flags: e.flags, model: e.model, version: e.version, kind: e.kind });
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
    const t = taskRequest.saved;
    if (t) {
      setMade({ n: ++seq.current, slug: ws.active, markdown: t.markdown ?? "", title: t.title, cardIds: t.cards, flags: t.flags ?? [], answers: t.flag_answers ?? {}, model: "", version: t.version, kind: t.kind === "rebuild" ? "rebuild" : "build" });
      return;
    }
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
      {made && <TaskPreview key={made.n} ws={ws} made={made} onClose={() => setMade(null)} onSaved={() => void refresh()} />}
    </>
  );
}

function TaskPreview({ ws, made: first, onClose, onSaved }: { ws: Workspace; made: Made; onClose: () => void; onSaved: () => void }) {
  const [made, setMade] = useState(first);
  const [text, setText] = useState(first.markdown);
  const [answers, setAnswers] = useState<FlagAnswers>(first.answers ?? {});
  /** The answers as of the last Apply (null: never applied). */
  const [applied, setApplied] = useState<FlagAnswers | null>(first.answers && Object.keys(trimmed(first.answers)).length ? trimmed(first.answers) : null);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const cards = made.cardIds.map((id) => ws.data?.cards.find((c) => c.id === id)).filter((c): c is Card => !!c);
  const html = useMemo(() => (preview ? renderDoc(text) : ""), [preview, text]);
  const linked = !!ws.data?.meta.handoff_target && ws.data.meta.handoff_target_confirmed === ws.data.meta.handoff_target;
  const cardTitle = (id?: string | null) => (id && ws.data?.cards.find((c) => c.id === id)?.title) || null;
  const fail = (e: unknown) => ws.setError(String(e));

  /** Saves (once, unless `next` is given: a new file) and returns the repo-relative path; null when it needs a repo first or failed. */
  const save = async (next?: { made: Made; text: string; answers: FlagAnswers }): Promise<string | null> => {
    if (saved && !next) return saved;
    const m = next?.made ?? made;
    if (!linked) {
      void api.pickFolder("Repo folder").then((p) => p && setLinking(p), fail);
      ws.toast("Link a repo first, then save the task.");
      return null;
    }
    setBusy(true);
    try {
      const file = await api.saveTask(m.slug, { markdown: next?.text ?? text, title: m.title, card_ids: m.cardIds, kind: m.kind, version: m.version, flags: m.flags, flag_answers: trimmed(next?.answers ?? answers) });
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

  /** Q/A into the flagged cards (one undo step), then a rebuild (Include card picks) or a revise of the text, then a new file. */
  const apply = async () => {
    const all = trimmed(answers);
    const prev = applied ?? {};
    const changed = made.flags.flatMap((f, i) => (all[i] && all[i] !== prev[i] ? [{ f, i, a: all[i] }] : []));
    const isInclude = (f: TaskFlag, a: string) => !!f.needs_card_id && !!cardTitle(f.needs_card_id) && a === includeLabel(cardTitle(f.needs_card_id)!);
    const includes = [...new Set(changed.filter((x) => isInclude(x.f, x.a)).map((x) => x.f.needs_card_id!))].filter((id) => !made.cardIds.includes(id));
    const decided = changed.filter((x) => !isInclude(x.f, x.a));
    setApplying(true);
    try {
      const add = new Map<string, string>();
      for (const { f, a } of decided) if (f.card_id) add.set(f.card_id, `${add.get(f.card_id) ?? ""}\n\n**Q:** ${question(f)}\n**A:** ${a}`);
      const edits = [...add].flatMap(([id, qa]) => {
        const c = ws.data?.cards.find((x) => x.id === id);
        return c ? [{ id, patch: { body: c.body ? `${c.body}${qa}` : qa.trimStart() } }] : [];
      });
      await ws.updateMany("record decisions", edits);
      let next: Made;
      let nextText: string;
      let nextAnswers = answers;
      if (includes.length) {
        const e = await runTask(made.slug, [...made.cardIds, ...includes], made.model || undefined);
        // Carry over the decisions whose card and question survive the rebuild.
        nextAnswers = {};
        e.flags.forEach((nf, j) => {
          const k = made.flags.findIndex((of, i) => all[i] && !isInclude(of, all[i]) && (of.card_id ?? null) === (nf.card_id ?? null) && question(of) === question(nf));
          if (k >= 0) nextAnswers[j] = all[k];
        });
        next = { ...made, markdown: e.markdown, title: e.title, cardIds: e.card_ids, flags: e.flags, kind: e.kind, model: e.model };
        nextText = e.markdown;
      } else if (decided.length) {
        const e = await runTask(made.slug, made.cardIds, made.model || undefined, { markdown: text, decisions: decided.map(({ f, a }) => ({ question: question(f), answer: a })) });
        next = { ...made, model: e.model };
        nextText = e.markdown;
      } else {
        next = made;
        nextText = text;
      }
      setMade(next);
      setText(nextText);
      setAnswers(nextAnswers);
      setApplied(trimmed(nextAnswers));
      setSaved(null);
      await save({ made: next, text: nextText, answers: nextAnswers });
    } catch (e) {
      ws.toast(String(e).replace(/^Error: /, ""));
    } finally {
      setApplying(false);
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
          <span className="chat-sub">{made.kind === "rebuild" ? "Rebuild" : "Build"}{made.version ? ` · ${made.version}` : ""}{made.model ? ` · ${made.model}` : ""}</span>
        </div>
        <div className="task-chips">
          {cards.map((c) => (
            <button key={c.id} type="button" className="chip" title="Open this card" onClick={() => void ws.focusCard(c.id)}>{c.title}</button>
          ))}
        </div>
        {made.flags.length > 0 && (
          <FlagStepper
            flags={made.flags}
            answers={answers}
            applied={applied}
            busy={applying}
            cardTitle={cardTitle}
            inScope={(id) => made.cardIds.includes(id)}
            onAnswer={(i, a) => setAnswers((x) => ({ ...x, [i]: a }))}
            onApply={() => void apply()}
          />
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
          <button type="button" className="btn" disabled={busy || applying || !!saved} onClick={() => void save()}>{saved ? "Saved" : "Save task"}</button>
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

/** The thin spots as a stepper of questions: chips, an own-decision box, Skip; Apply writes them back. */
function FlagStepper({ flags, answers, applied, busy, cardTitle, inScope, onAnswer, onApply }: {
  flags: TaskFlag[];
  answers: FlagAnswers;
  applied: FlagAnswers | null;
  busy: boolean;
  cardTitle: (id?: string | null) => string | null;
  inScope: (id: string) => boolean;
  onAnswer: (i: number, a: string) => void;
  onApply: () => void;
}) {
  const n = flags.length;
  const has = (i: number, a = answers) => !!a[i]?.trim();
  const [i, setI] = useState(() => Math.max(0, flags.findIndex((_, k) => !has(k))));
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set());
  const [open, setOpen] = useState(applied === null);
  const decided = flags.filter((_, k) => has(k)).length;
  const left = n - decided;
  const now = trimmed(answers);
  const before = applied ?? {};
  const dirty = decided > 0 && (Object.keys(now).length !== Object.keys(before).length || Object.keys(now).some((k) => now[k] !== before[k]));
  // After an Apply: fold away unless something is still open.
  const appliedRef = useRef(applied);
  useEffect(() => {
    if (applied === appliedRef.current) return;
    appliedRef.current = applied;
    setOpen(flags.some((_, k) => !applied?.[k]));
    setSkipped(new Set());
    setI(Math.max(0, flags.findIndex((_, k) => !applied?.[k])));
  }, [applied, flags]);
  const i0 = Math.min(i, n - 1);
  const f = flags[i0];
  /** The next question without an answer (skipped ones last); stays put when all are answered. */
  const advance = (a: FlagAnswers, skip: Set<number>) => {
    const order = Array.from({ length: n - 1 }, (_, k) => (i0 + 1 + k) % n);
    const to = order.find((k) => !has(k, a) && !skip.has(k)) ?? order.find((k) => !has(k, a));
    if (to !== undefined) setI(to);
  };
  const record = (a: string) => {
    onAnswer(i0, a);
    const s = new Set(skipped);
    s.delete(i0);
    setSkipped(s);
    if (a.trim()) advance({ ...answers, [i0]: a }, s);
  };
  const title = cardTitle(f.card_id);
  const needs = f.needs_card_id && !inScope(f.needs_card_id) ? cardTitle(f.needs_card_id) : null;
  const chips = [...(f.recommended ? [f.recommended] : []), ...(f.choices ?? []).filter((c) => c !== f.recommended), ...(needs ? [includeLabel(needs)] : [])];
  const answer = answers[i0] ?? "";
  const own = chips.includes(answer) ? "" : answer;
  const summary = `${decided} decided ✓${left ? ` · ${left} open` : ""}`;
  return (
    <section className="task-flags flag-stepper" aria-label="Thin spots">
      {applied !== null && (
        <button type="button" className="link-btn flag-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {summary} {open ? "▾" : "▸"}
        </button>
      )}
      {open && (
        <>
          <div className="flag-step-head">
            <strong>Question {i0 + 1} of {n}</strong>
            <span className="flag-dots" aria-label={`${decided} of ${n} answered`}>
              {flags.map((_, k) => (
                <button
                  key={k}
                  type="button"
                  className={"flag-dot" + (k === i0 ? " on" : "") + (has(k) ? " done" : skipped.has(k) ? " skipped" : "")}
                  aria-label={`Question ${k + 1}: ${has(k) ? "answered" : skipped.has(k) ? "skipped" : "open"}`}
                  aria-current={k === i0 || undefined}
                  onClick={() => setI(k)}
                />
              ))}
            </span>
            <div className="side-spacer" />
            <button type="button" className="chip" disabled={i0 === 0} onClick={() => setI(i0 - 1)}>‹ Prev</button>
            <button type="button" className="chip" disabled={i0 === n - 1} onClick={() => setI(i0 + 1)}>Next ›</button>
          </div>
          <div className="question">
            {title && <div className="question-context">{title}</div>}
            <strong>{question(f)}</strong>
            {f.question?.trim() && <div className="question-context">{f.text}</div>}
            {chips.length > 0 && (
              <div className="chips question-chips" role="radiogroup" aria-label={question(f)}>
                {chips.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={answer === c} className={"chip" + (answer === c ? " on" : "")} onClick={() => record(c)}>
                    {c}
                    {c === f.recommended && <span className="rec-tag">Recommended</span>}
                  </button>
                ))}
              </div>
            )}
            <textarea
              className="question-other flag-own"
              rows={1}
              placeholder="Your own decision…"
              aria-label="Your own decision"
              value={own}
              onChange={(e) => onAnswer(i0, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  record(own);
                }
              }}
            />
            <button
              type="button"
              className="link-btn question-skip"
              onClick={() => {
                const s = new Set(skipped).add(i0);
                setSkipped(s);
                onAnswer(i0, "");
                advance({ ...answers, [i0]: "" }, s);
              }}
            >
              Skip
            </button>
          </div>
          <div className="flag-step-foot">
            <div className="side-spacer" />
            <button type="button" className="btn primary" disabled={busy || !dirty} onClick={onApply}>{busy ? "Applying…" : "Apply decisions"}</button>
          </div>
        </>
      )}
    </section>
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
                <button type="button" className="chip" title="Reopen in the build dialog" onClick={() => ws.openTask({ kind: "selection", ids: t.cards }, t)}>Review</button>
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
