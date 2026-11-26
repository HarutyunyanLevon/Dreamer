import { useEffect, useRef, useState } from "react";
import { api, type SearchHit } from "../api";
import type { Workspace } from "../state/workspace";
import { Modal } from "../ui/Modal";
import { ScrollArea } from "../ui/Scroll";
import { KIND_LABEL } from "./kinds";

const DEBOUNCE_MS = 100;

/**
 * Ctrl+K: keyword search over card files using the same `search_cards` command Claude's tool
 * uses, with no Claude call. Enter (or a click) pans the canvas to the card and selects it.
 */
export function SearchPalette({ ws, onClose }: { ws: Workspace; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [allProjects, setAllProjects] = useState(true);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    const my = ++seq.current;
    if (!q) {
      setHits([]);
      setError(null);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .searchCards(q, allProjects ? undefined : (ws.active ?? undefined), 30)
        .then((r) => {
          if (my !== seq.current) return;
          setHits(r);
          setCursor(0);
          setError(null);
        })
        .catch((e) => my === seq.current && setError(String(e)));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, allProjects, ws.active]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // In linking mode a hit in this project completes the link, wherever its folder is.
  const linking = ws.linkMode && ws.linkFrom ? ws.linkFrom : null;
  const open = (h: SearchHit) => {
    onClose();
    if (linking && h.project === ws.active && h.id !== linking) {
      ws.addLink(linking, h.id);
      ws.setLinking(false);
      ws.toast(`Linked to “${h.title || "Untitled"}”.`);
      return;
    }
    void ws.focusCard(h.id, h.project);
  };

  return (
    <Modal onClose={onClose} label="Search cards" size="md" className="palette" align="top">
        <div className="palette-input-row">
          <input
            className="name-input palette-input"
            autoFocus
            value={query}
            placeholder={linking ? "Link to which card?" : "Search cards…"}
            aria-label="Search cards"
            aria-controls="palette-results"
            aria-activedescendant={hits[cursor] ? `palette-hit-${cursor}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(hits.length - 1, c + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(0, c - 1));
              } else if (e.key === "Enter" && hits[cursor]) {
                e.preventDefault();
                open(hits[cursor]);
              }
            }}
          />
          <div className="stage-filter" role="group" aria-label="Search scope">
            <button type="button" className={"filter" + (!allProjects ? " on" : "")} aria-pressed={!allProjects} onClick={() => setAllProjects(false)}>
              This project
            </button>
            <button type="button" className={"filter" + (allProjects ? " on" : "")} aria-pressed={allProjects} onClick={() => setAllProjects(true)}>
              All
            </button>
          </div>
        </div>
        {error && <p className="setup-error">{error}</p>}
        {query.trim() && !error && hits.length === 0 && <p className="palette-empty">No cards match “{query.trim()}”.</p>}
        {hits.length > 0 && (
          <ScrollArea as="ul" className="palette-results" id="palette-results" role="listbox" ref={listRef}>
            {hits.map((h, i) => (
              <li
                key={`${h.project}:${h.id}`}
                id={`palette-hit-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === cursor}
                className={"palette-hit" + (i === cursor ? " on" : "") + (h.ghost ? " ghost" : "")}
                onMouseEnter={() => setCursor(i)}
                onClick={() => open(h)}
              >
                <div className="palette-hit-head">
                  {!h.kind || h.kind === "card" ? <span className={`dot dot-${h.stage}`} aria-hidden="true" /> : <span className="palette-kind">{KIND_LABEL[h.kind]}</span>}
                  <span className="palette-hit-title">{h.title || "Untitled"}</span>
                  {h.ghost && <span className="palette-badge">suggestion</span>}
                  <span className="palette-hit-proj">{h.project_name}</span>
                </div>
                {h.snippet && <div className="palette-snippet">{h.snippet}</div>}
                {h.tags.length > 0 && <div className="palette-tags">{h.tags.map((t) => `#${t}`).join(" ")}</div>}
              </li>
            ))}
          </ScrollArea>
        )}
        <div className="palette-foot chat-sub">↑↓ to move · Enter to {linking ? "link to it" : "open"} · Esc to close</div>
    </Modal>
  );
}
