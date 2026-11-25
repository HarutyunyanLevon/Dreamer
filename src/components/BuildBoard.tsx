import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BuildBlock, type Card, type HandoffEvent, type ProjectData, type TaskFlag, type TaskKind } from "../api";
import { buildRuns } from "../state/buildRuns";
import { cardVersions, type Workspace } from "../state/useWorkspace";
import { Modal } from "../ui/Modal";
import { needsRebuild } from "../util/build";
import { renderDoc } from "../util/markdown";
import { openVersion } from "./Versions";

type Col = "dream" | "queued" | "building" | "built" | "rebuild";
const COLS: { id: Col; title: string }[] = [
  { id: "dream", title: "Dream" },
  { id: "queued", title: "Queued" },
  { id: "building", title: "Building" },
  { id: "built", title: "Built" },
  { id: "rebuild", title: "Needs rebuild" },
];

/** Which column a card is in; null = not on the board. */
export function columnOf(c: Card, lucid: boolean): Col | null {
  if (c.kind !== "card" || c.role || c.ghost) return null;
  const st = c.build?.status;
  if (needsRebuild(c)) return "rebuild";
  if (st === "queued") return "queued";
  if (st === "in-progress" || st === "blocked") return "building";
  if (c.stage === "built") return "built";
  if (c.stage === "dream" || (lucid && c.stage === "lucid")) return "dream";
  return null;
}

/** Board moves (drag back undoes the same move). Returns the new build block, or null when not allowed. */
function move(c: Card, from: Col, to: Col): BuildBlock | "mark-built" | null {
  const b = c.build ?? {};
  if (from === "dream" && to === "queued") return { ...b, status: "queued" };
  if (from === "queued" && to === "dream" && c.stage !== "built") {
    const { status: _s, task: _t, ...rest } = b;
    return rest;
  }
  if (from === "built" && to === "rebuild") return { ...b, dirty: true, dirty_manual: true };
  if (from === "rebuild" && to === "built") {
    if (!b.dirty_manual) return "mark-built"; // drift from an edit: the saved card becomes the built version
    const { dirty_manual: _m, ...rest } = b;
    return { ...rest, dirty: false };
  }
  return null;
}

/** Cards linked "part of" / "needs" inside the queue go into one task. */
export function queueGroups(cards: Card[]): string[][] {
  const ids = cards.map((c) => c.id);
  const parent = new Map(ids.map((i) => [i, i]));
  const find = (i: string): string => (parent.get(i) === i ? i : find(parent.get(i)!));
  for (const c of cards) {
    for (const l of c.links) {
      if (parent.has(l.to) && /^\s*(part of|needs)\s*$/i.test(l.label ?? "")) parent.set(find(c.id), find(l.to));
    }
  }
  const groups = new Map<string, string[]>();
  for (const i of ids) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return [...groups.values()];
}

function boardCards(data: ProjectData, folder: string | null): Card[] {
  const open = openVersion(data, folder);
  const of = cardVersions(data);
  return data.cards.filter((c) => !open || of.get(c.id) === open.id);
}

/** The Build board of the open version: Dream | Queued | Building | Built | Needs rebuild. */
export function BuildBoard({ ws, onOpen }: { ws: Workspace; onOpen: (id: string) => void }) {
  const data = ws.data!;
  const [lucid, setLucid] = useState(false);
  const [over, setOver] = useState<Col | null>(null);
  const [queue, setQueue] = useState<string[][] | null>(null);
  const drag = useRef<{ id: string; from: Col } | null>(null);
  const cards = useMemo(() => boardCards(data, ws.folder), [data, ws.folder]);
  const cols = useMemo(() => {
    const m: Record<Col, Card[]> = { dream: [], queued: [], building: [], built: [], rebuild: [] };
    for (const c of cards) {
      const col = columnOf(c, lucid);
      if (col) m[col].push(c);
    }
    return m;
  }, [cards, lucid]);

  const drop = (to: Col) => {
    setOver(null);
    const d = drag.current;
    drag.current = null;
    const c = d && cards.find((x) => x.id === d.id);
    if (!d || !c || d.from === to) return;
    const next = move(c, d.from, to);
    if (next === null) return ws.toast("That move isn't possible on the board.");
    if (next === "mark-built") return void ws.markBuiltNow(c.id);
    void ws.setBuildBlock(c.id, next, `move to ${COLS.find((x) => x.id === to)!.title}`);
  };

  return (
    <section className="build-board" aria-label="Build board">
      {COLS.map(({ id, title }) => (
        <div
          key={id}
          className={"board-col" + (over === id ? " drop-hover" : "")}
          onDragOver={(e) => {
            if (!drag.current) return;
            e.preventDefault();
            setOver(id);
          }}
          onDragLeave={() => setOver((o) => (o === id ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            drop(id);
          }}
        >
          <div className="board-col-head">
            <strong>{title}</strong>
            <span className="chat-sub">{cols[id].length}</span>
            <div className="side-spacer" />
            {id === "dream" && (
              <label className="check-row board-lucid">
                <input type="checkbox" checked={lucid} onChange={(e) => setLucid(e.target.checked)} /> Show Lucid
              </label>
            )}
          </div>
          {id === "queued" && (
            <button type="button" className="btn" disabled={!cols.queued.length} onClick={() => setQueue(queueGroups(cols.queued))}>Build queue</button>
          )}
          {id === "rebuild" && (
            <button type="button" className="btn" disabled={!cols.rebuild.length} onClick={() => ws.openTask({ kind: "selection", ids: cols.rebuild.map((c) => c.id) })}>Prompt for all</button>
          )}
          <div className="board-cards scroll scroll-y">
            {cols[id].map((c) => (
              <button
                key={c.id}
                type="button"
                className={"board-card" + (c.build?.status === "in-progress" ? " building" : "")}
                draggable
                onDragStart={(e) => {
                  drag.current = { id: c.id, from: id };
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", c.title);
                }}
                onDragEnd={() => {
                  drag.current = null;
                  setOver(null);
                }}
                onClick={() => onOpen(c.id)}
              >
                <span className="board-card-title">
                  <span className={`dot dot-${c.stage}`} aria-hidden="true" />
                  {c.title || "Untitled"}
                </span>
                {(c.tags.length > 0 || c.build?.task || c.build?.status === "blocked" || c.build?.status === "partial") && (
                  <span className="board-card-meta">
                    {c.build?.status === "blocked" && <span className="status-pill blocked">blocked</span>}
                    {c.build?.status === "partial" && <span className="status-pill partial">partial</span>}
                    {c.tags.slice(0, 3).map((t) => <span key={t} className="tag">{t}</span>)}
                    {c.build?.task && <span className="chip task-chip" title={c.build.task}>{c.build.task.split("/").pop()!.replace(/\.md$/, "")}</span>}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
      {queue && <QueueDialog ws={ws} groups={queue} onClose={() => setQueue(null)} />}
    </section>
  );
}

interface Item {
  ids: string[];
  state: "waiting" | "writing" | "ready" | "failed";
  error?: string;
  title?: string;
  text?: string;
  flags?: TaskFlag[];
  kind?: TaskKind;
  version?: string;
}

/** One "Make build prompt" session; resolves with its finished task. */
function makeTask(slug: string, ids: string[]): Promise<Extract<HandoffEvent, { type: "done"; mode: "task" }>> {
  return new Promise((resolve, reject) => {
    let job: string | null = null;
    const early: HandoffEvent[] = [];
    let un: (() => void) | null = null;
    const handle = (e: HandoffEvent) => {
      if (e.job !== job) return;
      if (e.type === "done" && e.mode === "task") {
        un?.();
        resolve(e);
      } else if (e.type === "error") {
        un?.();
        reject(new Error(e.message));
      }
    };
    api
      .onHandoffEvent((e) => (job === null ? early.push(e) : handle(e)))
      .then(async (u) => {
        un = u;
        job = await api.taskStart(slug, ids);
        early.splice(0).forEach(handle);
      })
      .catch((e) => {
        un?.();
        reject(e);
      });
  });
}

/** "Build queue": one task per group, written one after another; each editable; then Run all on one branch. */
function QueueDialog({ ws, groups, onClose }: { ws: Workspace; groups: string[][]; onClose: () => void }) {
  const slug = ws.active!;
  const [items, setItems] = useState<Item[]>(() => groups.map((ids) => ({ ids, state: "waiting" })));
  const [open, setOpen] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const stopped = useRef(false);
  const title = (id: string) => ws.data?.cards.find((c) => c.id === id)?.title ?? id;
  const patch = (i: number, p: Partial<Item>) => setItems((xs) => xs.map((x, k) => (k === i ? { ...x, ...p } : x)));

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      for (let i = 0; i < groups.length && !stopped.current; i++) {
        patch(i, { state: "writing" });
        try {
          const d = await makeTask(slug, groups[i]);
          patch(i, { state: "ready", title: d.title, text: d.markdown, flags: d.flags, kind: d.kind, version: d.version });
        } catch (e) {
          patch(i, { state: "failed", error: String(e).replace(/^Error: /, "") });
        }
      }
    })();
    // Once per dialog; `groups` is fixed for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const close = () => {
    stopped.current = true;
    if (items.some((x) => x.state === "writing")) void api.handoffCancel().catch(() => {});
    onClose();
  };
  const ready = items.filter((x) => x.state === "ready");
  const runAll = async () => {
    setBusy(true);
    try {
      const files: string[] = [];
      for (const x of ready) files.push(await api.saveTask(slug, { markdown: x.text!, title: x.title!, card_ids: x.ids, kind: x.kind ?? "build", version: x.version ?? "" }));
      buildRuns.requestStart(slug, files);
      onClose();
    } catch (e) {
      ws.setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  const cur = open !== null ? items[open] : null;
  return (
    <Modal onClose={close} label="Build queue" size="lg" placement="canvas" className="design-view task-preview">
      <h3 className="dialog-title">Build queue</h3>
      <p className="chat-sub">One task per card (cards linked “part of” or “needs” share one). Run all builds them one after another on one branch, and stops at the first failure.</p>
      <ol className="queue-list">
        {items.map((x, i) => (
          <li key={i} className={x.state}>
            <div>
              <strong>{x.title ?? x.ids.map(title).join(" + ")}</strong>
              <div className="chat-sub">
                {x.state === "waiting" ? "Waiting" : x.state === "writing" ? "Writing the task…" : x.state === "failed" ? x.error : `${x.ids.map(title).join(", ")}${x.flags?.length ? ` · ${x.flags.length} thin spot(s)` : ""}`}
              </div>
            </div>
            {x.state === "ready" && <button type="button" className="chip" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>{open === i ? "Close" : "Edit"}</button>}
          </li>
        ))}
      </ol>
      {cur && cur.state === "ready" && (
        <>
          {!!cur.flags?.length && (
            <ul className="task-flags" aria-label="Thin spots">
              {cur.flags.map((f, k) => <li key={k}>{f.card_id ? <strong>{title(f.card_id)}: </strong> : null}{f.text}</li>)}
            </ul>
          )}
          <div className="seg" role="group" aria-label="Editor or preview">
            <button type="button" className={"chip" + (!preview ? " on" : "")} aria-pressed={!preview} onClick={() => setPreview(false)}>Edit</button>
            <button type="button" className={"chip" + (preview ? " on" : "")} aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
          </div>
          {preview ? (
            <div className="design-body doc task-body" dangerouslySetInnerHTML={{ __html: renderDoc(cur.text ?? "") }} />
          ) : (
            <textarea className="task-edit" aria-label="Task markdown" spellCheck={false} value={cur.text} onChange={(e) => patch(open!, { text: e.target.value })} />
          )}
        </>
      )}
      <div className="editor-actions design-actions">
        <div className="side-spacer" />
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !ready.length || items.some((x) => x.state === "waiting" || x.state === "writing")}
          title="Saves every task into the repo, then runs them in order on one branch"
          onClick={() => void runAll()}
        >
          Run all ({ready.length})
        </button>
      </div>
    </Modal>
  );
}
