import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Card, type HandoffEvent, type HandoffRepoResult, type HandoffScope, type HandoffSpec, type ProjectData } from "../api";
import { type Workspace } from "../state/workspace";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { LinkRepoWrites } from "./LinkRepo";
import { Modal } from "../ui/Modal";
import { CARD_H, CARD_W } from "./cardGeometry";
import { LiveActivity, StepList, applyJobEvent, newJobActivity, type JobActivity } from "./Activity";

/**
 * The project handoff pack ("Summarize"): the export dialog and the generation progress panel.
 * The pack is written into the linked repo folder, replacing the last one. One handoff session
 * runs at a time (enforced in Rust too).
 */
export function HandoffHost({ ws }: { ws: Workspace }) {
  const [dialog, setDialog] = useState<{ scope: HandoffScope; n: number } | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const runJob = useRef<string | null>(null);

  const req = ws.handoffRequest;
  const { clearHandoff } = ws;
  useEffect(() => {
    if (!req) return;
    setDialog({ scope: req.scope, n: req.n });
    clearHandoff();
  }, [req, clearHandoff]);

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    api
      .onHandoffEvent((e) => {
        // The first progress event can arrive before handoffStart resolves with the id.
        if (runJob.current !== e.job && runJob.current !== "pending") return;
        if (runJob.current === "pending") runJob.current = e.job;
        setRun((r) => (r ? reduceRun(r, e) : r));
      })
      .then((u) => (gone ? u() : (un = u)))
      .catch(() => {});
    return () => {
      gone = true;
      un?.();
    };
  }, []);

  const generate = useCallback(
    async (spec: HandoffSpec) => {
      const slug = ws.active;
      if (!slug) return;
      runJob.current = "pending";
      const images = countImages(ws.data, spec);
      setRun({ slug, activity: newJobActivity(), phase: "reading", read: 0, total: 0, viewed: 0, images, written: 0, doc: null, note: null, result: null, error: null });
      try {
        runJob.current = await api.handoffStart(slug, spec);
        setDialog(null);
      } catch (e) {
        runJob.current = null;
        setRun(null);
        throw e;
      }
    },
    [ws.active, ws.data],
  );

  const cancel = () => {
    runJob.current = null;
    setRun(null);
    void api.handoffCancel().catch((e) => ws.setError(String(e)));
    ws.toast("Cancelled. Nothing was written.");
  };

  return (
    <>
      {dialog && ws.data && (
        <HandoffDialog
          key={dialog.n}
          ws={ws}
          data={ws.data}
          initial={dialog.scope}
          busy={!!run && !run.result && !run.error}
          onClose={() => setDialog(null)}
          onGenerate={generate}
        />
      )}
      {run && (
        <HandoffProgress
          run={run}
          onCancel={cancel}
          onClose={() => {
            runJob.current = null;
            setRun(null);
          }}
        />
      )}
    </>
  );
}

// ---------- scope (mirrors resolve_scope in handoff.rs, for the live count) ----------

const ALL_STAGES: StageId[] = [...STAGES];
const LINK_DEPTH = 2;

/** The cards a spec covers. The core resolves the scope again when it runs; this is the preview. */
function cardsInScope(data: ProjectData, spec: HandoffSpec): Card[] {
  const live = data.cards.filter((c) => !c.ghost);
  const byId = new Map(live.map((c) => [c.id, c]));
  let base = new Set<string>();
  const s = spec.scope;
  if (s.kind === "project") base = new Set(live.map((c) => c.id));
  else if (s.kind === "selection") base = new Set(s.ids.filter((id) => byId.has(id)));
  else if (s.kind === "frames") {
    const frames = s.ids.map((id) => data.canvas.frames?.[id]).filter((f) => !!f);
    for (const c of live) {
      const p = data.canvas.cards[c.id];
      if (!p) continue;
      const cx = p.x + (p.w ?? CARD_W) / 2;
      const cy = p.y + (p.h ?? CARD_H) / 2;
      if (frames.some((f) => cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h)) base.add(c.id);
    }
  } else if (byId.has(s.id)) {
    base.add(s.id);
    let frontier = [s.id];
    for (let d = 0; d < LINK_DEPTH; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const out = byId.get(cur)?.links.map((l) => l.to) ?? [];
        const inc = live.filter((c) => c.links.some((l) => l.to === cur)).map((c) => c.id);
        for (const id of [...out, ...inc]) if (byId.has(id) && !base.has(id)) (base.add(id), next.push(id));
      }
      frontier = next;
    }
  }
  return live.filter((c) => {
    if (c.role === "tech" || c.role === "decisions") return true;
    if (!base.has(c.id)) return false;
    if (c.kind === "card") return spec.stages.includes(c.stage);
    if (c.kind === "artifact") return false; // artifacts go in through approval, not as cards
    return true;
  });
}

function countImages(data: ProjectData | null, spec: HandoffSpec): number {
  if (!data) return 0;
  return cardsInScope(data, spec).reduce((n, c) => n + c.attachments.filter((a) => a.type === "image").length, 0);
}

const frameTitle = (t: string) => t.trim() || "Untitled frame";

// ---------- the export dialog ----------

function HandoffDialog({
  ws,
  data,
  initial,
  busy,
  onClose,
  onGenerate,
}: {
  ws: Workspace;
  data: ProjectData;
  initial: HandoffScope;
  busy: boolean;
  onClose: () => void;
  onGenerate: (spec: HandoffSpec) => Promise<void>;
}) {
  const slug = data.slug;
  // The selection and the "from here" card are fixed when the dialog opens.
  const [selection] = useState<string[]>(() => (initial.kind === "selection" ? initial.ids : ws.getCanvasSelection().filter((id) => data.cards.some((c) => c.id === id && !c.ghost))));
  const fromCard = initial.kind === "card" ? data.cards.find((c) => c.id === initial.id) : undefined;
  const frames = useMemo(() => Object.entries(data.canvas.frames ?? {}).sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x), [data.canvas.frames]);
  const [kind, setKind] = useState<HandoffScope["kind"]>(initial.kind);
  const [frameIds, setFrameIds] = useState<Set<string>>(() => new Set(initial.kind === "frames" ? initial.ids : []));
  const [stages, setStages] = useState<Set<StageId>>(() => new Set(ALL_STAGES));
  const [model, setModel] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | (() => void)>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.getSettings().then((s) => setModel(s.model_export)).catch(() => setModel("?"));
  }, []);

  const scope: HandoffScope =
    kind === "project" ? { kind } : kind === "selection" ? { kind, ids: selection } : kind === "frames" ? { kind, ids: [...frameIds] } : { kind: "card", id: fromCard?.id ?? "" };
  const spec: HandoffSpec = { scope, stages: ALL_STAGES.filter((s) => stages.has(s)) };
  const inScope = cardsInScope(data, spec);
  const target = data.meta.handoff_target ?? null;

  /** Generation, behind the first-use confirm when a repo folder is set. */
  const generate = () => {
    const go = async () => {
      setError(null);
      setStarting(true);
      try {
        await onGenerate(spec);
      } catch (e) {
        setError(String(e));
      } finally {
        setStarting(false);
      }
    };
    if (target && data.meta.handoff_target_confirmed !== target) {
      setConfirming(() => async () => {
        setConfirming(null);
        try {
          await api.linkRepo(slug, target);
          await ws.refresh();
          await go();
        } catch (e) {
          setError(String(e));
        }
      });
      return;
    }
    void go();
  };

  const pickTarget = async () => {
    setError(null);
    try {
      const path = await api.pickFolder("Repo folder for the design docs");
      if (!path) return;
      await api.updateProject(slug, { handoff_target: path });
      await ws.refresh();
    } catch (e) {
      setError(String(e));
    }
  };
  const clearTarget = async () => {
    try {
      await api.updateProject(slug, { handoff_target: "" });
      await ws.refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const locked = starting || busy;
  const scopeEmpty = (kind === "frames" && frameIds.size === 0) || inScope.length === 0;
  const scopeOptions: { kind: HandoffScope["kind"]; label: string; disabled?: string }[] = [
    { kind: "project", label: "Whole project" },
    { kind: "selection", label: selection.length ? `Selection (${selection.length})` : "Selection", disabled: selection.length ? undefined : "Select cards on the canvas first" },
    { kind: "frames", label: "Frames", disabled: frames.length ? undefined : "This project has no frames" },
  ];
  if (fromCard) scopeOptions.push({ kind: "card", label: `From “${fromCard.title}”` });

  return (
    <Modal onClose={onClose} label="Summarize: handoff pack" size="md" className="handoff-dialog">
      <h3 className="dialog-title">Summarize into a handoff pack</h3>
      <p className="chat-sub handoff-lede">Claude turns the cards into design docs, a roadmap and a CLAUDE.md that Claude Code can build from. The pack is written into your repo folder and replaced each time.</p>

      <fieldset className="handoff-group" disabled={locked}>
        <legend>Scope</legend>
        <div className="seg" role="radiogroup" aria-label="Scope">
          {scopeOptions.map((o) => (
            <button
              key={o.kind}
              type="button"
              role="radio"
              aria-checked={kind === o.kind}
              aria-disabled={o.disabled ? true : undefined}
              title={o.disabled}
              className={"chip" + (kind === o.kind ? " on" : "")}
              onClick={() => !o.disabled && setKind(o.kind)}
            >
              {o.label}
            </button>
          ))}
        </div>
        {kind === "card" && fromCard && <p className="chat-sub">The card and the cards linked to it, up to two links away.</p>}
        {kind === "frames" && (
          <div className="handoff-frames" role="group" aria-label="Frames">
            {frames.map(([id, f]) => (
              <label key={id} className="handoff-check">
                <input
                  type="checkbox"
                  checked={frameIds.has(id)}
                  onChange={(e) =>
                    setFrameIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(id);
                      else next.delete(id);
                      return next;
                    })
                  }
                />
                {frameTitle(f.title)}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="handoff-group" disabled={locked}>
        <legend>Stages</legend>
        <div className="seg" role="group" aria-label="Stages to include">
          {ALL_STAGES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={stages.has(s)}
              className={"chip" + (stages.has(s) ? " on" : "")}
              onClick={() =>
                setStages((prev) => {
                  const next = new Set(prev);
                  if (next.has(s)) next.delete(s);
                  else next.add(s);
                  return next;
                })
              }
            >
              <span className={`dot dot-${s}`} aria-hidden="true" /> {STAGE_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="chat-sub" aria-live="polite">
          {inScope.length} card{inScope.length === 1 ? "" : "s"} in scope. Mist cards go in as unconfirmed ideas; the Tech &amp; constraints and Project decisions cards are always included.
        </p>
      </fieldset>

      <fieldset className="handoff-group" disabled={locked}>
        <legend>Repo folder</legend>
        <div className="handoff-target">
          <code className="dialog-path" title={target ?? undefined}>{target ?? "None: choose the repo the pack is written into"}</code>
          <button type="button" className="btn" onClick={() => void pickTarget()}>{target ? "Change…" : "Choose…"}</button>
          {target && <button type="button" className="btn" onClick={() => void clearTarget()}>Clear</button>}
        </div>
        <p className="chat-sub">The pack is written to docs/design/ in this folder, replacing the last one, and the Dreamer block of its CLAUDE.md is updated.</p>
      </fieldset>

      <p className="chat-sub">Model: <strong>{model ?? "…"}</strong> (change it under Claude › Models, “Handoff pack”).</p>

      {error && <p className="setup-error" role="alert">{error}</p>}

      {confirming ? (
        <div className="handoff-confirm" role="alertdialog" aria-label="Write into the repo folder?">
          <p><strong>Write into this folder?</strong></p>
          <code className="dialog-path">{target}</code>
          <LinkRepoWrites />
          <div className="editor-actions">
            <div className="side-spacer" />
            <button type="button" className="btn" onClick={() => setConfirming(null)}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirming()}>Write and generate</button>
          </div>
        </div>
      ) : (
        <div className="editor-actions handoff-actions">
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn primary" disabled={locked || scopeEmpty || !target} onClick={generate} title={target ? "Undecided points become TBDs in 04-open-questions.md" : "Choose the repo folder first"}>
            Generate
          </button>
        </div>
      )}
      {busy && <p className="chat-sub">A handoff pack is being written. Wait for it, or cancel it in its panel.</p>}
    </Modal>
  );
}

// ---------- generation progress ----------

interface RunState {
  slug: string;
  activity: JobActivity;
  phase: "reading" | "viewing" | "writing" | "copying" | "done";
  read: number;
  total: number;
  viewed: number;
  images: number;
  written: number;
  doc: string | null;
  note: string | null;
  result: HandoffRepoResult | null;
  error: string | null;
}

function reduceRun(prev: RunState, e: HandoffEvent): RunState {
  const r = { ...prev, activity: applyJobEvent(prev.activity, e) };
  switch (e.type) {
    case "progress":
      if (e.step === "reading") return { ...r, phase: "reading", read: e.read, total: e.total || r.total, images: e.images ?? r.images };
      if (e.step === "viewing") return { ...r, phase: "viewing", viewed: e.viewed, images: Math.max(e.images, r.images) };
      if (e.step === "writing") return { ...r, phase: "writing", written: e.written, doc: e.doc };
      return { ...r, phase: "copying" };
    case "note":
      return { ...r, note: e.note || r.note };
    case "done":
      return { ...r, phase: "done", result: { path: e.path, files: e.files, warnings: e.warnings } };
    case "error":
      return { ...r, error: e.message };
    default:
      return r;
  }
}

/** What the status line names when no step is running: the pipeline phase. */
function phaseLabel(run: RunState): string {
  switch (run.phase) {
    case "reading":
      return run.total ? `Reading cards ${run.read} / ${run.total}` : "Reading cards…";
    case "viewing":
      return `Viewing images ${run.viewed} / ${run.images}`;
    case "writing":
      return `Writing docs ${run.written} / 7`;
    default:
      return "Copying…";
  }
}

function HandoffProgress({ run, onCancel, onClose }: { run: RunState; onCancel: () => void; onClose: () => void }) {
  const a = run.activity;
  const r = run.result;
  const stepRunning = a.steps.some((s) => s.status === "running");
  return (
    <section className="glass handoff-progress" aria-label="Handoff pack progress" aria-live="polite" data-wheel-boundary="">
      <div className="handoff-progress-head">
        <div className="orb small" aria-hidden="true" />
        <strong>{r ? "The design pack is ready" : run.error ? "The handoff pack failed" : "Writing the handoff pack"}</strong>
      </div>
      {!r && !run.error && (
        <div className="handoff-activity scroll scroll-y">
          <LiveActivity steps={a.steps} usage={a.usage} startedAt={a.startedAt} lastEventAt={a.lastEventAt} label={stepRunning ? undefined : phaseLabel(run)} />
        </div>
      )}
      {!r && run.error && a.steps.length > 0 && (
        <div className="handoff-activity scroll scroll-y">
          <StepList steps={a.steps} now={Date.now()} />
        </div>
      )}
      {run.error && <p className="setup-error" role="alert">{run.error} Nothing was written.</p>}
      {r && (
        <div className="handoff-result">
          <p className="chat-sub">Written into {r.path}: {r.files.length} file{r.files.length === 1 ? "" : "s"} in docs/design/ and the Dreamer block of CLAUDE.md. Claude Code takes it from there.</p>
          {r.warnings.map((w) => (
            <p key={w} className="chat-sub">{w}</p>
          ))}
        </div>
      )}
      <div className="editor-actions">
        <div className="side-spacer" />
        {r ? (
          <button type="button" className="btn primary" onClick={onClose}>Close</button>
        ) : run.error ? (
          <button type="button" className="btn" onClick={onClose}>Close</button>
        ) : (
          <button type="button" className="btn" onClick={onCancel} title="Stop Claude; nothing is written">Cancel</button>
        )}
      </div>
    </section>
  );
}
