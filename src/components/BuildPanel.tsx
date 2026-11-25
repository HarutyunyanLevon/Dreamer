import { useEffect, useState } from "react";
import { api, type BuildAsk, type BuildLogEvent, type BuildSummary } from "../api";
import { buildRuns, liveRunOf, useBuildRuns, type LiveRun, type TimelineItem } from "../state/buildRuns";
import type { Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";
import { ScrollArea } from "../ui/Scroll";
import { parseUnified } from "../util/diff";
import { fmtDuration, fmtTokens } from "./Activity";

const fail = (ws: Workspace) => (e: unknown) => ws.setError(String(e).replace(/^Error: /, ""));
const RESULT: Record<string, string> = { done: "Finished", failed: "Failed", interrupted: "Interrupted" };

/** The right panel's "Build" tab: the current run, its queue, the last summary and past runs. */
export function BuildPanel({ ws }: { ws: Workspace }) {
  const slug = ws.active;
  const st = useBuildRuns();
  const live = liveRunOf(st, slug);
  const ended = slug ? st.ended[slug] : undefined;
  const [past, setPast] = useState<BuildSummary[] | null>(null);
  const [open, setOpen] = useState<BuildSummary | null>(null);
  const { setError } = ws;

  useEffect(() => {
    if (!slug) return;
    let on = true;
    api.buildRuns(slug).then((runs) => {
      if (!on) return;
      runs.forEach((r) => r.live && buildRuns.adopt(r));
      setPast(runs.filter((r): r is BuildSummary => !r.live));
    }, (e) => on && setError(String(e)));
    return () => {
      on = false;
    };
  }, [slug, st.stamp, setError]);

  if (!slug || slug === "inbox") return <div className="build-panel"><p className="chat-sub">Open a project to build it.</p></div>;
  return (
    <ScrollArea boundary className="chat-body build-panel">
      {live ? <LiveView ws={ws} run={live} /> : !ended && <p className="chat-sub">No build is running. Use “Run in Dreamer” on a saved task, or the Build board’s queue.</p>}
      {ended && !live && <SummaryCard ws={ws} summary={ended} onClose={() => buildRuns.closeEnded(slug)} />}
      <h4 className="settings-sub">Past runs</h4>
      {past === null ? (
        <p className="chat-sub">Loading…</p>
      ) : past.length === 0 ? (
        <p className="chat-sub">None yet.</p>
      ) : (
        <ul className="build-runs">
          {past.map((r) => (
            <li key={r.id}>
              <button type="button" className="build-run-row" onClick={() => setOpen(r)}>
                <span className={`status-pill ${r.result === "done" ? "built" : "blocked"}`}>{RESULT[r.result] ?? r.result}</span>
                <span className="build-run-title">{r.titles.join(" · ") || r.branch}</span>
                <span className="chat-sub">{new Date(r.started_at).toLocaleString()} · {fmtDuration(r.duration_ms)}{r.outcome ? ` · ${r.outcome}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <Modal onClose={() => setOpen(null)} label="Build run" size="lg">
          <SummaryCard ws={ws} summary={open} onClose={() => setOpen(null)} log />
        </Modal>
      )}
    </ScrollArea>
  );
}

function LiveView({ ws, run }: { ws: Workspace; run: LiveRun }) {
  const { info } = run;
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const started = Date.parse(info.started_at);
  return (
    <section className="build-live" aria-live="polite">
      <div className="build-live-head">
        <div className="orb small" aria-hidden="true" />
        <div>
          <strong>Building on <code>{info.branch}</code></strong>
          <div className="chat-sub">from {info.base} · {info.model} · {fmtDuration(Date.now() - started)}{run.output ? ` · ${fmtTokens(run.output)} out` : ""}</div>
        </div>
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={() => void api.buildInterrupt(info.id).catch(fail(ws))} title="Stop Claude Code; the branch is kept">Interrupt</button>
      </div>
      {info.tasks.length > 1 && (
        <ol className="build-queue" aria-label="Queue">
          {info.titles.map((t, i) => (
            <li key={i} className={i < info.current ? "done" : i === info.current ? "now" : undefined}>{t}</li>
          ))}
        </ol>
      )}
      <div className="build-timeline">
        {run.items.length === 0 && <p className="chat-sub">Starting Claude Code in the repo…</p>}
        {run.items.map((x, i) => <Item key={i} ws={ws} run={info.id} item={x} titles={info.titles} />)}
      </div>
    </section>
  );
}

function Item({ ws, run, item, titles }: { ws: Workspace; run: string; item: TimelineItem; titles: string[] }) {
  switch (item.t) {
    case "step":
      return item.step.kind === "thinking" ? null : (
        <div className={`build-step ${item.step.status}`} title={item.step.detail ?? undefined}>
          <span className="build-step-dot" aria-hidden="true" />
          <span>{item.step.label || item.step.tool}</span>
        </div>
      );
    case "text":
      return <p className="build-text">{item.text}</p>;
    case "denied":
      return <div className="build-step error">Blocked {item.tool}: {item.reason}</div>;
    case "task":
      return <div className="build-task-sep">Next task: {titles[item.index]}</div>;
    case "ask":
      return <AskCard ws={ws} run={run} ask={item.ask} decision={item.decision} />;
  }
}

function AskCard({ ws, run, ask, decision }: { ws: Workspace; run: string; ask: BuildAsk; decision?: string }) {
  const [reason, setReason] = useState("");
  const [denying, setDenying] = useState(false);
  const answer = (d: "once" | "prefix" | "deny") => void api.buildAnswer(run, ask.req, d, d === "deny" ? reason : undefined).catch(fail(ws));
  return (
    <div className={"build-ask" + (decision ? " answered" : "")} role={decision ? undefined : "alert"}>
      <div><strong>{ask.why}</strong></div>
      {ask.description && <div className="chat-sub">{ask.description}</div>}
      {ask.detail && <code className="build-ask-detail">{ask.detail}</code>}
      {decision ? (
        <div className="chat-sub">{decision[0].toUpperCase() + decision.slice(1)}.</div>
      ) : denying ? (
        <form className="build-ask-actions" onSubmit={(e) => { e.preventDefault(); answer("deny"); }}>
          <input className="name-input" autoFocus value={reason} placeholder="Why (optional, sent to Claude)" onChange={(e) => setReason(e.target.value)} />
          <button type="submit" className="btn primary">Deny</button>
          <button type="button" className="btn" onClick={() => setDenying(false)}>Back</button>
        </form>
      ) : (
        <div className="build-ask-actions">
          <button type="button" className="btn primary" onClick={() => answer("once")}>Allow once</button>
          {ask.prefix && <button type="button" className="btn" onClick={() => answer("prefix")} title="Every command starting with this, until the run ends">Allow <code>{ask.prefix}</code> for this run</button>}
          <button type="button" className="btn" onClick={() => setDenying(true)}>Deny…</button>
        </div>
      )}
    </div>
  );
}

/** After a run: result, commits, files, STATUS entries; diff, merge, terminal, delete, keep. */
export function SummaryCard({ ws, summary, onClose, log = false }: { ws: Workspace; summary: BuildSummary; onClose: () => void; log?: boolean }) {
  const [s, setS] = useState(summary);
  const [diffs, setDiffs] = useState(false);
  const [file, setFile] = useState<{ name: string; text: string | null } | null>(null);
  const [confirm, setConfirm] = useState<"merge" | "delete" | null>(null);
  const [events, setEvents] = useState<BuildLogEvent[] | null>(null);
  const slug = s.slug;
  useEffect(() => setS(summary), [summary]);
  const act = (a: "merge" | "delete" | "keep") =>
    api.buildAct(slug, s.id, a).then((n) => {
      setS(n);
      buildRuns.setEnded(n);
      ws.toast(a === "merge" ? `Merged into ${n.base} (${n.outcome}). Nothing was pushed.` : a === "delete" ? `Deleted ${n.branch}.` : `Kept ${n.branch}.`);
    }, fail(ws));
  const showFile = (name: string) => {
    setFile({ name, text: null });
    api.buildFileDiff(slug, s.id, name).then((text) => setFile({ name, text }), fail(ws));
  };
  const done = !!s.outcome && s.outcome !== "kept";
  return (
    <section className="build-summary">
      <div className="build-live-head">
        <span className={`status-pill ${s.result === "done" ? "built" : "blocked"}`}>{RESULT[s.result] ?? s.result}</span>
        <strong>{s.titles.join(" · ")}</strong>
        <div className="side-spacer" />
        <span className="chat-sub">{fmtDuration(s.duration_ms)}</span>
      </div>
      {s.error && <p className="setup-error">{s.error}</p>}
      <div className="chat-sub">
        Branch <code>{s.branch}</code> from <code>{s.base}</code>{s.stashed ? " · your changes were stashed first (git stash pop)" : ""}{s.outcome ? ` · ${s.outcome}` : ""}
      </div>
      <h4 className="settings-sub">Commits ({s.commits.length})</h4>
      {s.commits.length === 0 ? <p className="chat-sub">No commits.</p> : (
        <ul className="build-list-plain">{s.commits.map((c) => <li key={c.hash}><code>{c.hash}</code> {c.subject}</li>)}</ul>
      )}
      <h4 className="settings-sub">Files changed ({s.files.length})</h4>
      {s.files.length > 0 && (
        <ul className="build-list-plain">
          {s.files.map((f) => (
            <li key={f}>{diffs ? <button type="button" className="link-btn" onClick={() => showFile(f)}>{f}</button> : <code>{f}</code>}</li>
          ))}
        </ul>
      )}
      {file && (
        <div className="build-diff" role="region" aria-label={`Diff of ${file.name}`}>
          {file.text === null ? "Loading…" : parseUnified(file.text).map((l, i) => (
            <div key={i} className={l.kind === "same" ? undefined : l.kind}>{l.kind === "add" ? "+ " : l.kind === "del" ? "− " : "  "}{l.text}</div>
          ))}
        </div>
      )}
      <h4 className="settings-sub">STATUS.md</h4>
      {s.status.length === 0 && s.missing.length === 0 && <p className="chat-sub">No cards.</p>}
      <ul className="build-list-plain">
        {s.status.map((e) => <li key={e.id}><span className={`status-pill ${e.status ?? ""}`}>{e.status ?? "?"}</span> {e.title || e.id}{e.notes ? ` — ${e.notes}` : ""}</li>)}
        {s.missing.map((m) => <li key={m.id} className="build-missing">No status reported for {m.title}</li>)}
      </ul>
      {log && (
        <>
          <button type="button" className="chip" onClick={() => api.buildEvents(slug, s.id).then(setEvents, fail(ws))}>Show log</button>
          {events && (
            <div className="build-timeline">
              {events.filter((e) => e.type === "step" || e.type === "text" || e.type === "ask" || e.type === "denied").map((e, i) => (
                <div key={i} className={e.type === "text" ? "build-text" : "build-step done"}>{e.type === "step" ? String(e.label || e.tool) : e.type === "text" ? String(e.text) : e.type === "ask" ? `Asked: ${String(e.why)}` : `Blocked: ${String(e.reason)}`}</div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="editor-actions">
        <button type="button" className="btn" disabled={!s.files.length} onClick={() => { setDiffs((v) => !v); setFile(null); }}>{diffs ? "Hide diff" : "Show diff"}</button>
        <button type="button" className="btn" disabled={done} onClick={() => setConfirm("merge")}>Merge into {s.base}</button>
        <button type="button" className="btn" onClick={() => void api.buildOpenTerminal(slug).catch(fail(ws))}>Open terminal here</button>
        <button type="button" className="btn" disabled={done} onClick={() => setConfirm("delete")}>Delete branch</button>
        <button type="button" className="btn" disabled={done} onClick={() => void act("keep").then(onClose)}>Keep branch</button>
      </div>
      {confirm && (
        <Modal onClose={() => setConfirm(null)} label={confirm === "merge" ? "Merge" : "Delete branch"} size="sm">
          <h3 className="dialog-title">{confirm === "merge" ? `Merge into ${s.base}?` : `Delete ${s.branch}?`}</h3>
          <p>{confirm === "merge" ? `Checks out ${s.base} and merges ${s.branch} (fast-forward when possible, else a merge commit). Nothing is pushed.` : `Its ${s.commits.length} commit(s) are lost unless merged elsewhere.`}</p>
          <div className="editor-actions">
            <div className="side-spacer" />
            <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => { const a = confirm; setConfirm(null); void act(a); }}>{confirm === "merge" ? "Merge" : "Delete"}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Starts the run asked for with buildRuns.requestStart: checks the repo, asks about a dirty tree. */
export function BuildStartHost({ ws }: { ws: Workspace }) {
  const { start } = useBuildRuns();
  const [dirty, setDirty] = useState<{ branch: string } | null>(null);
  const { setError } = ws;
  const go = (how: "stash" | "continue" | "clean") => {
    if (!start) return;
    setDirty(null);
    buildRuns.clearStart();
    api.buildStart(start.slug, start.tasks, how).then(() => buildRuns.showTab("build"), (e) => setError(String(e).replace(/^Error: /, "")));
  };
  useEffect(() => {
    if (!start) return;
    let on = true;
    api.buildPreflight(start.slug).then(
      (p) => {
        if (!on) return;
        if (p.busy) {
          buildRuns.clearStart();
          buildRuns.showTab("build");
          setError("A build run is already going on in this repo.");
        } else if (p.dirty) setDirty({ branch: p.branch });
        else go("clean");
      },
      (e) => {
        buildRuns.clearStart();
        if (on) setError(String(e).replace(/^Error: /, ""));
      },
    );
    return () => {
      on = false;
    };
    // `go` reads `start`, which is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  if (!start || !dirty) return null;
  return (
    <Modal onClose={() => { setDirty(null); buildRuns.clearStart(); }} label="Uncommitted changes" size="sm">
      <h3 className="dialog-title">The repo has uncommitted changes</h3>
      <p>The run makes a new branch from <code>{dirty.branch}</code>. Stash your changes first (get them back with <code>git stash pop</code>), or take them along onto the new branch.</p>
      <div className="editor-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={() => { setDirty(null); buildRuns.clearStart(); }}>Cancel</button>
        <button type="button" className="btn" onClick={() => go("continue")}>Continue anyway</button>
        <button type="button" className="btn primary" onClick={() => go("stash")}>Stash and continue</button>
      </div>
    </Modal>
  );
}
