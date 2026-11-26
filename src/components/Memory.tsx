import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type MemoryLogEntry, type MemoryView } from "../api";
import type { Workspace } from "../state/workspace";
import { diffLines } from "../util/diff";
import { emptyMemory, fromEditor, MEMORY_SECTIONS, memoryWords, parseMemory, renderMemory, toEditor, type MemoryLines } from "../util/memory";
import { Modal } from "../ui/Modal";
import { ScrollArea } from "../ui/Scroll";
import { IconClose } from "./Icons";

const SOURCE_LABEL: Record<MemoryLogEntry["source"], string> = { auto: "Auto", user: "You", claude: "Claude (asked)", seed: "Seed" };
const MIN_KEPT_CARDS = 3;

/**
 * Owns the project memory UI: the first-open seed (a project with >= 3 kept cards and no memory.md
 * gets one draft query; the draft opens in the modal) and the Memory modal itself.
 */
export function MemoryHost({ ws }: { ws: Workspace }) {
  const [seed, setSeed] = useState<{ slug: string; text: string } | null>(null);
  const asked = useRef(new Set<string>());
  const slug = ws.active;
  const kept = ws.data && ws.data.slug === slug ? ws.data.cards.filter((c) => !c.ghost).length : 0;
  const { setMemoryOpen, setError } = ws;

  useEffect(() => {
    let un: (() => void) | undefined;
    let off = false;
    api
      .onMemoryEvent((e) => {
        if (e.type === "seed") {
          setSeed({ slug: e.slug, text: e.text });
          setMemoryOpen(true);
        }
      })
      .then((u) => (off ? u() : (un = u)))
      .catch((e) => setError(String(e)));
    return () => {
      off = true;
      un?.();
    };
  }, [setMemoryOpen, setError]);

  // Bootstrap: once per project per session, when it has enough kept cards and no memory yet.
  useEffect(() => {
    if (!slug || slug === "inbox" || kept < MIN_KEPT_CARDS || asked.current.has(slug)) return;
    asked.current.add(slug);
    api
      .memoryGet(slug)
      .then((v) => (v.exists ? undefined : api.memorySeed(slug)))
      .catch(() => {});
  }, [slug, kept]);

  if (!ws.memoryOpen || !slug || slug === "inbox") return null;
  const draft = seed && seed.slug === slug ? seed.text : null;
  return <MemoryModal key={slug + (draft ? ":seed" : "")} slug={slug} name={ws.data?.meta.name ?? slug} seed={draft} onClose={() => ws.setMemoryOpen(false)} onSeedDone={() => setSeed(null)} onError={ws.setError} />;
}

function MemoryModal({ slug, name, seed, onClose, onSeedDone, onError }: { slug: string; name: string; seed: string | null; onClose: () => void; onSeedDone: () => void; onError: (e: string) => void }) {
  const [tab, setTab] = useState<"memory" | "history">("memory");
  const [view, setView] = useState<MemoryView | null>(null);
  const [lines, setLines] = useState<MemoryLines>(() => (seed ? parseMemory(seed) : emptyMemory()));
  const [dirty, setDirty] = useState(false);
  /** Seed draft shown read-only until the user chooses Edit. */
  const [editing, setEditing] = useState(!seed);
  const [history, setHistory] = useState<MemoryLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    try {
      const v = await api.memoryGet(slug);
      setView(v);
      if (!seed && !dirtyRef.current) setLines(parseMemory(v.text));
      setHistory(await api.memoryHistory(slug));
    } catch (e) {
      onError(String(e));
    }
  }, [slug, seed, onError]);

  useEffect(() => {
    void load();
    let un: (() => void) | undefined;
    let off = false;
    // memory.md changed on disk (a memory pass, Claude, an editor): reload unless the user is mid-edit.
    api
      .onChange((evs) => {
        if (evs.some((e) => e.scope === "memory" && e.project === slug)) void load();
      })
      .then((u) => (off ? u() : (un = u)))
      .catch(() => {});
    return () => {
      off = true;
      un?.();
    };
  }, [load, slug]);

  const cap = view?.cap ?? 600;
  const words = useMemo(() => memoryWords(lines), [lines]);
  const over = words > cap;

  const save = async (source: "user" | "seed", text: string) => {
    setBusy(true);
    try {
      const v = await api.memorySave(slug, text, source);
      setView(v);
      setLines(parseMemory(v.text));
      setDirty(false);
      if (seed) {
        onSeedDone();
        onClose();
      } else {
        setHistory(await api.memoryHistory(slug));
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const revert = async (at: string) => {
    setBusy(true);
    try {
      setView(await api.memoryRevert(slug, at));
      setDirty(false);
      await load();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={`Memory of ${name}`} size="lg" className="memory-modal">
      <div className="modal-head">
        <h3>Memory · {name}</h3>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      {seed && (
        <p className="proposal-reason">
          This project has no memory yet. Claude drafted one from your Tech, decisions, Dream and Lucid cards. Keep it, edit it, or start empty. You will not be asked again.
        </p>
      )}
      {!seed && (
        <div className="design-tabs" role="tablist" aria-label="Memory">
          <button type="button" role="tab" aria-selected={tab === "memory"} className={"chip" + (tab === "memory" ? " on" : "")} onClick={() => setTab("memory")}>
            Memory
          </button>
          <button type="button" role="tab" aria-selected={tab === "history"} className={"chip" + (tab === "history" ? " on" : "")} onClick={() => setTab("history")}>
            History{history.length ? ` (${history.length})` : ""}
          </button>
        </div>
      )}

      {tab === "memory" && (
        <>
          <ScrollArea className="memory-sections">
            {MEMORY_SECTIONS.map((s) => (
              <label key={s} className="memory-section">
                <span>{s}</span>
                {editing ? (
                  <textarea
                    className="name-input"
                    rows={Math.max(2, lines[s].length + 1)}
                    value={toEditor(lines[s])}
                    placeholder="One line per bullet"
                    onChange={(e) => {
                      setLines({ ...lines, [s]: fromEditor(e.target.value) });
                      setDirty(true);
                    }}
                    onBlur={(e) => setLines({ ...lines, [s]: fromEditor(e.target.value) })}
                  />
                ) : (
                  <ul className="memory-read">{lines[s].length ? lines[s].map((l, i) => <li key={i}>{l}</li>) : <li className="chat-sub">(empty)</li>}</ul>
                )}
              </label>
            ))}
          </ScrollArea>
          <div className="editor-actions">
            <span className={"memory-count" + (over ? " over" : "")} aria-live="polite">
              {words} / {cap} words
            </span>
            <div className="side-spacer" />
            {seed ? (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => void save("seed", renderMemory(emptyMemory()))}>
                  Start empty
                </button>
                {editing ? (
                  <button type="button" className="btn primary" disabled={busy || over} onClick={() => void save("user", renderMemory(lines))}>
                    Save
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
                      Edit
                    </button>
                    <button type="button" className="btn primary" disabled={busy || over} onClick={() => void save("seed", renderMemory(lines))}>
                      Keep
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={onClose}>
                  Close
                </button>
                <button type="button" className="btn primary" disabled={busy || !dirty || over} title={over ? "Over the word cap: shorten it first" : undefined} onClick={() => void save("user", renderMemory(lines))}>
                  Save
                </button>
              </>
            )}
          </div>
        </>
      )}

      {tab === "history" && (
        <ScrollArea className="memory-history">
          {history.length === 0 && <p className="chat-sub">No changes yet.</p>}
          {history.map((h) => (
            <section key={h.at} className="memory-entry">
              <div className="memory-entry-head">
                <time dateTime={h.at}>{new Date(h.at).toLocaleString()}</time>
                <span className={`memory-source src-${h.source}`}>{SOURCE_LABEL[h.source] ?? h.source}</span>
                <div className="side-spacer" />
                <button type="button" className="chip" disabled={busy} title="Undo just this change (later edits stay)" onClick={() => void revert(h.at)}>
                  Revert
                </button>
              </div>
              <pre className="memory-diff">
                {diffLines(h.before, h.after)
                  .filter((d) => d.kind !== "same" && d.text.trim() && !d.text.startsWith("## "))
                  .map((d, i) => (
                    <div key={i} className={d.kind === "add" ? "d-add" : "d-del"}>
                      {d.kind === "add" ? "+ " : "− "}
                      {d.text.replace(/^-\s*/, "")}
                    </div>
                  ))}
              </pre>
            </section>
          ))}
        </ScrollArea>
      )}
    </Modal>
  );
}
