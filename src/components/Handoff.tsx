import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Card, type Gap, type HandoffEvent, type HandoffRepoResult, type HandoffScope, type HandoffSpec, type ProjectData } from "../api";
import { cardVersions, folderChain, folderName, versionOf, versionsOf, type Workspace } from "../state/useWorkspace";
import { STAGES, STAGE_LABEL, type StageId } from "../theme/types";
import { LinkRepoWrites } from "./LinkRepo";
import { Modal } from "../ui/Modal";
import { CARD_H, CARD_W } from "./cardGeometry";
import { DesignView } from "./DesignView";
import { LiveActivity, StepList, applyJobEvent, newJobActivity, type JobActivity } from "./Activity";

/**
 * The project handoff pack ("Summarize"): the export dialog, the gap check, the generation progress
 * panel and the Design view. One handoff session runs at a time (enforced in Rust too).
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

  const { refresh } = ws;
  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    api
      .onHandoffEvent((e) => {
        // The first progress event can arrive before handoffStart resolves with the id.
        if (runJob.current !== e.job && runJob.current !== "pending") return;
        if (runJob.current === "pending") runJob.current = e.job;
        setRun((r) => (r ? reduceRun(r, e) : r));
        if (e.type === "done" && e.mode === "generate") void refresh();
      })
      .then((u) => (gone ? u() : (un = u)))
      .catch(() => {});
    return () => {
      gone = true;
      un?.();
    };
  }, [refresh]);

  const generate = useCallback(
    async (spec: HandoffSpec, gaps: Gap[] | null) => {
      const slug = ws.active;
      if (!slug) return;
      runJob.current = "pending";
      const images = countImages(ws.data, spec);
      setRun({ slug, activity: newJobActivity(), phase: "reading", read: 0, total: 0, viewed: 0, images, written: 0, doc: null, note: null, result: null, error: null });
      try {
        runJob.current = await api.handoffStart(slug, "generate", spec, gaps ?? undefined);
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
          onOpen={() => {
            runJob.current = null;
            setRun(null);
            if (ws.active === run.slug) ws.setDesignOpen(true);
          }}
        />
      )}
      {ws.designOpen && ws.active && <DesignView ws={ws} onClose={() => ws.setDesignOpen(false)} onNewVersion={() => setDialog({ scope: { kind: "project" }, n: Date.now() })} />}
    </>
  );
}

// ---------- scope (mirrors resolve_scope in handoff.rs, for the live count) ----------

const ALL_STAGES: StageId[] = [...STAGES];
const LINK_DEPTH = 2;

/** The cards a spec covers. The core resolves the scope again when it runs; this is the preview. */
export function cardsInScope(data: ProjectData, spec: HandoffSpec): Card[] {
  const of = spec.version ? cardVersions(data) : null;
  const live = data.cards.filter((c) => !c.ghost && (!of || of.get(c.id) === spec.version));
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
  } else if (s.kind === "folder") {
    // The folder and every folder below it.
    const sub = [s.id];
    for (let i = 0; i < sub.length; i++) sub.push(...data.folders.filter((f) => f.parent === sub[i]).map((f) => f.id));
    for (const f of sub) for (const id of Object.keys(data.canvases[f]?.cards ?? {})) if (byId.has(id)) base.add(id);
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
    if (c.kind === "sticky") return spec.include_stickies;
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

type GapState = { status: "idle" } | { status: "running"; job: string | null; activity: JobActivity } | { status: "done"; gaps: Gap[] } | { status: "error"; message: string };

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
  onGenerate: (spec: HandoffSpec, gaps: Gap[] | null) => Promise<void>;
}) {
  const slug = data.slug;
  // The selection and the "from here" card are fixed when the dialog opens.
  const [selection] = useState<string[]>(() => (initial.kind === "selection" ? initial.ids : ws.getCanvasSelection().filter((id) => data.cards.some((c) => c.id === id && !c.ghost))));
  const fromCard = initial.kind === "card" ? data.cards.find((c) => c.id === initial.id) : undefined;
  const frames = useMemo(() => Object.entries(data.canvas.frames ?? {}).sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x), [data.canvas.frames]);
  const [kind, setKind] = useState<HandoffScope["kind"]>(initial.kind);
  // The folder scope: the one asked for, else the folder open on the canvas.
  const scopeFolder = initial.kind === "folder" ? initial.id : ws.folder;
  const folderTitle = folderChain(data.folders, scopeFolder).map(folderName).join(" / ");
  const [frameIds, setFrameIds] = useState<Set<string>>(() => new Set(initial.kind === "frames" ? initial.ids : []));
  const [stages, setStages] = useState<Set<StageId>>(() => new Set(ALL_STAGES));
  const [stickies, setStickies] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [gap, setGap] = useState<GapState>({ status: "idle" });
  const [confirming, setConfirming] = useState<null | (() => void)>(null);
  const [ignoreDreamer, setIgnoreDreamer] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const gapJob = useRef<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => setModel(s.model_export)).catch(() => setModel("?"));
  }, []);

  const scope: HandoffScope =
    kind === "project" ? { kind } : kind === "selection" ? { kind, ids: selection } : kind === "frames" ? { kind, ids: [...frameIds] } : kind === "folder" ? { kind, id: scopeFolder ?? "" } : { kind: "card", id: fromCard?.id ?? "" };
  // Project versions: the pack is of one version, the open one by default.
  const versions = versionsOf(data.folders);
  const [version, setVersion] = useState<string | undefined>(() => versionOf(data.folders, initial.kind === "folder" ? initial.id : ws.folder)?.id ?? data.meta.last_version ?? versions[versions.length - 1]?.id);
  const spec: HandoffSpec = { scope, stages: ALL_STAGES.filter((s) => stages.has(s)), include_stickies: stickies, ...(versions.length && version ? { version } : {}) };
  const inScope = cardsInScope(data, spec);
  const target = data.meta.handoff_target ?? null;

  // Gap check events (its own job id; the progress panel only follows generation).
  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    api
      .onHandoffEvent((e: HandoffEvent) => {
        if (!gapJob.current || (gapJob.current !== e.job && gapJob.current !== "pending")) return;
        if (gapJob.current === "pending") gapJob.current = e.job;
        setGap((g) => (g.status === "running" ? { ...g, activity: applyJobEvent(g.activity, e) } : g));
        if (e.type === "gaps") setGap({ status: "done", gaps: e.gaps });
        else if (e.type === "error") {
          gapJob.current = null;
          setGap({ status: "error", message: e.message });
        } else if (e.type === "done") gapJob.current = null;
      })
      .then((u) => (gone ? u() : (un = u)))
      .catch(() => {});
    return () => {
      gone = true;
      un?.();
    };
  }, []);

  // Closing the dialog during a gap check cancels it.
  const close = () => {
    if (gap.status === "running") void api.handoffCancel().catch(() => {});
    gapJob.current = null;
    onClose();
  };

  const runGapCheck = async () => {
    setError(null);
    gapJob.current = "pending";
    setGap({ status: "running", job: null, activity: newJobActivity() });
    try {
      const job = await api.handoffStart(slug, "gaps", spec);
      if (gapJob.current === "pending") gapJob.current = job;
    } catch (e) {
      gapJob.current = null;
      setGap({ status: "idle" });
      setError(String(e));
    }
  };

  const cancelGapCheck = () => {
    gapJob.current = null;
    setGap({ status: "idle" });
    void api.handoffCancel().catch(() => {});
  };

  /** Generation, behind the first-use confirm when a repo folder is set. */
  const generate = () => {
    const go = async () => {
      setError(null);
      setStarting(true);
      try {
        await onGenerate(spec, gap.status === "done" ? gap.gaps : null);
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
          await api.linkRepo(slug, target, ignoreDreamer);
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

  const fillWithGrill = (gaps: Gap[]) => {
    const open = gaps.filter((g) => g.status !== "ok");
    const text = [
      "/grill-me handoff: interview me about these gaps from the handoff gap check, in this order:",
      ...open.map((g) => `- ${g.item} [${g.status}]: ${g.note}`),
    ].join("\n");
    close();
    ws.setContextCard(null);
    ws.requestChat({ thread: null, send: true, quiet: true, text, display: `/grill-me on ${open.length} gap${open.length === 1 ? "" : "s"}` });
  };

  const running = gap.status === "running";
  const locked = running || starting || busy;
  const scopeEmpty = (kind === "frames" && frameIds.size === 0) || inScope.length === 0;
  const scopeOptions: { kind: HandoffScope["kind"]; label: string; disabled?: string }[] = [
    { kind: "project", label: versions.length ? "Whole version" : "Whole project" },
    { kind: "selection", label: selection.length ? `Selection (${selection.length})` : "Selection", disabled: selection.length ? undefined : "Select cards on the canvas first" },
    { kind: "frames", label: "Frames", disabled: frames.length ? undefined : "This project has no frames" },
  ];
  if (scopeFolder && folderTitle) scopeOptions.push({ kind: "folder", label: `Folder “${folderTitle}”` });
  if (fromCard) scopeOptions.push({ kind: "card", label: `From “${fromCard.title}”` });

  return (
    <Modal onClose={close} label="Summarize: handoff pack" size="md" className="handoff-dialog">
      <h3 className="dialog-title">Summarize into a handoff pack</h3>
      <p className="chat-sub handoff-lede">Claude turns the cards into design docs, a roadmap and a CLAUDE.md that Claude Code can build from. Each run is saved as a new version.</p>

      {versions.length > 1 && (
        <fieldset className="handoff-group" disabled={locked}>
          <legend>Version</legend>
          <div className="seg" role="radiogroup" aria-label="Project version">
            {versions.map((v) => (
              <button key={v.id} type="button" role="radio" aria-checked={version === v.id} className={"chip" + (version === v.id ? " on" : "")} onClick={() => setVersion(v.id)}>
                {folderName(v)}
              </button>
            ))}
          </div>
          <p className="chat-sub">Saved as the next revision of {folderName(versions.find((v) => v.id === version))} (design/&lt;version&gt;/r&lt;N&gt;/).</p>
        </fieldset>
      )}

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
        <label className="handoff-check">
          <input type="checkbox" checked={stickies} onChange={(e) => setStickies(e.target.checked)} />
          Include stickies
        </label>
        <p className="chat-sub" aria-live="polite">
          {inScope.length} card{inScope.length === 1 ? "" : "s"} in scope. Mist cards go in as unconfirmed ideas; the Tech &amp; constraints and Project decisions cards are always included.
        </p>
      </fieldset>

      <fieldset className="handoff-group" disabled={locked}>
        <legend>Repo folder</legend>
        <div className="handoff-target">
          <code className="dialog-path" title={target ?? undefined}>{target ?? "None: the pack is saved in the project only"}</code>
          <button type="button" className="btn" onClick={() => void pickTarget()}>{target ? "Change…" : "Choose…"}</button>
          {target && <button type="button" className="btn" onClick={() => void clearTarget()}>Clear</button>}
        </div>
        {target && <p className="chat-sub">Also copied to docs/design/ in this folder, with the Dreamer block of its CLAUDE.md updated.</p>}
      </fieldset>

      <p className="chat-sub">Model: <strong>{model ?? "…"}</strong> (change it under Claude › Models, “Handoff pack”).</p>

      {gap.status === "running" && (
        <div className="handoff-activity scroll scroll-y">
          <div className="search-trace-head">Checking the cards for gaps</div>
          <LiveActivity steps={gap.activity.steps} usage={gap.activity.usage} startedAt={gap.activity.startedAt} lastEventAt={gap.activity.lastEventAt} />
        </div>
      )}
      {gap.status === "error" && <p className="setup-error" role="alert">Gap check failed: {gap.message}</p>}
      {gap.status === "done" && <GapList gaps={gap.gaps} />}
      {error && <p className="setup-error" role="alert">{error}</p>}

      {confirming ? (
        <div className="handoff-confirm" role="alertdialog" aria-label="Write into the repo folder?">
          <p><strong>Write into this folder?</strong></p>
          <code className="dialog-path">{target}</code>
          <ul>
            <li><code>docs/design/</code>: the pack's docs and assets are replaced; other files there are left alone.</li>
            <li><code>docs/design/QUESTIONS.md</code>: created if missing, never overwritten.</li>
            <li><code>CLAUDE.md</code>: only the part between the Dreamer markers is replaced (the file is created, or the block appended, if needed).</li>
          </ul>
          <LinkRepoWrites />
          <label className="check-row"><input type="checkbox" checked={ignoreDreamer} onChange={(e) => setIgnoreDreamer(e.target.checked)} /> Add <code>.dreamer/</code> to the repo's .gitignore</label>
          <div className="editor-actions">
            <div className="side-spacer" />
            <button type="button" className="btn" onClick={() => setConfirming(null)}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void confirming()}>Write and generate</button>
          </div>
        </div>
      ) : (
        <div className="editor-actions handoff-actions">
          {gap.status === "done" && gap.gaps.some((g) => g.status !== "ok") && (
            <button type="button" className="btn" disabled={locked} onClick={() => fillWithGrill(gap.gaps)} title="Answer the thin and missing items in the project chat">
              Fill with grill-me
            </button>
          )}
          <div className="side-spacer" />
          <button type="button" className="btn" onClick={close}>Close</button>
          {running ? (
            <button type="button" className="btn" onClick={cancelGapCheck}>Cancel check</button>
          ) : gap.status === "done" ? (
            <>
              <button type="button" className="btn" disabled={locked || scopeEmpty} onClick={() => void runGapCheck()}>Check again</button>
              <button type="button" className="btn primary" disabled={locked || scopeEmpty} onClick={generate} title="Undecided points become TBDs in 04-open-questions.md">
                {gap.gaps.some((g) => g.status !== "ok") ? "Generate anyway" : "Generate"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" disabled={locked || scopeEmpty} onClick={generate} title="Write the docs now; undecided points become TBDs">Generate anyway</button>
              <button type="button" className="btn primary" disabled={locked || scopeEmpty} onClick={() => void runGapCheck()}>Run gap check</button>
            </>
          )}
        </div>
      )}
      {busy && <p className="chat-sub">A handoff pack is being written. Wait for it, or cancel it in its panel.</p>}
    </Modal>
  );
}

const GAP_LABEL: Record<Gap["status"], string> = { ok: "OK", thin: "Thin", missing: "Missing" };

function GapList({ gaps }: { gaps: Gap[] }) {
  const open = gaps.filter((g) => g.status !== "ok").length;
  return (
    <div className="gap-list" aria-label="Gap check result">
      <div className="search-trace-head">{open ? `${open} of ${gaps.length} items need attention` : "Every item is covered"}</div>
      <ul>
        {gaps.map((g) => (
          <li key={g.item} className={`gap gap-${g.status}`}>
            <span className={`gap-badge gap-${g.status}`}>{GAP_LABEL[g.status]}</span>
            <span className="gap-item">{g.item}</span>
            {g.note && <span className="gap-note">{g.note}</span>}
          </li>
        ))}
      </ul>
    </div>
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
  result: { version: number; label?: string; designDir?: string; dir: string; warnings: string[]; repo: HandoffRepoResult | null } | null;
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
      return e.mode === "generate" ? { ...r, phase: "done", result: { version: e.version, label: e.label, designDir: e.design_dir, dir: e.dir, warnings: e.warnings, repo: e.repo } } : r;
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

function HandoffProgress({ run, onCancel, onClose, onOpen }: { run: RunState; onCancel: () => void; onClose: () => void; onOpen: () => void }) {
  const a = run.activity;
  const r = run.result;
  const stepRunning = a.steps.some((s) => s.status === "running");
  return (
    <section className="glass handoff-progress" aria-label="Handoff pack progress" aria-live="polite" data-wheel-boundary="">
      <div className="handoff-progress-head">
        <div className="orb small" aria-hidden="true" />
        <strong>{r ? `Design ${r.label ?? `v${r.version}`} is ready` : run.error ? "The handoff pack failed" : "Writing the handoff pack"}</strong>
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
          <p className="chat-sub">Saved in the project under {r.designDir ? `design/${r.designDir}/r${r.version}` : `design/v${r.version}`}.</p>
          {r.repo && (r.repo.error ? <p className="setup-error">Copying to {r.repo.path} failed: {r.repo.error}</p> : <p className="chat-sub">Copied to {r.repo.path} (docs/design/ and CLAUDE.md).</p>)}
          {[...r.warnings, ...(r.repo?.warnings ?? [])].map((w) => (
            <p key={w} className="chat-sub">{w}</p>
          ))}
        </div>
      )}
      <div className="editor-actions">
        <div className="side-spacer" />
        {r ? (
          <>
            <button type="button" className="btn" onClick={onClose}>Close</button>
            <button type="button" className="btn primary" onClick={onOpen}>Open</button>
          </>
        ) : run.error ? (
          <button type="button" className="btn" onClick={onClose}>Close</button>
        ) : (
          <button type="button" className="btn" onClick={onCancel} title="Stop Claude; nothing is written">Cancel</button>
        )}
      </div>
    </section>
  );
}
