import { useCallback, useEffect, useRef, useState } from "react";
import { proposalPatch } from "../components/ProposalView";
import { api, type Attachment, type BuildBlock, type Canvas, type Card, type CardKind, type CardPatch, type EditProposal, type Folder, type Frame, type HandoffScope, type Link, type NewCard, type OrganizeLayout, type OrganizePlanData, type Pos, type ProjectData, type ProjectSummary } from "../api";
import { CARD_H, CARD_W, FOLDER_H, FOLDER_W } from "../components/cardGeometry";
import { DECISIONS_TITLE, TECH_TEMPLATE, TECH_TITLE, parseItem } from "../components/kinds";
import type { NewArtifact } from "../api";
import { ARTIFACT_LABEL, artifactType, createPrompt } from "../components/artifacts/prompts";

const INBOX = "inbox";
const CANVAS_SAVE_DEBOUNCE_MS = 500;

/** Client-side attachment id, so a just-added item can be referenced before the core echoes it back. */
const newAttId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const newFrameId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Card and folder positions + frames: what a frame edit changes (never the viewport). */
type Layout = Pick<Canvas, "cards" | "frames" | "folders">;
const layoutOf = (c: Canvas): Layout => ({ cards: c.cards, frames: c.frames ?? {}, folders: c.folders ?? {} });

/** Key of the root canvas in `ProjectData.canvases` (the UI keeps every canvas there). */
export const ROOT = "";
const keyOf = (f: string | null | undefined) => f ?? ROOT;
const newFolderId = () => `fd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const blankCanvas = (): Canvas => ({ version: 3, viewport: { x: 300, y: 110, zoom: 1 }, cards: {}, frames: {}, folders: {} });
/** Loaded data with the root canvas also under canvases[ROOT]. */
function withRoot(d: ProjectData): ProjectData {
  const canvases: Record<string, Canvas> = {};
  for (const [k, c] of Object.entries({ ...(d.canvases ?? {}), [ROOT]: d.canvas })) canvases[k] = { ...c, frames: c.frames ?? {}, folders: c.folders ?? {} };
  return { ...d, folders: d.folders ?? [], canvases };
}
/** The UI's view: `canvas` is the open folder's canvas. */
const viewOf = (d: ProjectData, folder: string | null): ProjectData => ({ ...d, canvas: d.canvases[keyOf(folder)] ?? d.canvases[ROOT] });

/** Folder records + every canvas: what a structural change (folders, moves between canvases) touches. */
export interface Structure {
  canvases: Record<string, Canvas>;
  folders: Folder[];
}
/** Things on one canvas that can move together. */
export interface Items {
  cards?: string[];
  frames?: string[];
  folders?: string[];
}
/** `id` is `anc` or below it. */
export function isInside(folders: Folder[], id: string, anc: string): boolean {
  let cur: string | null | undefined = id;
  for (let i = 0; cur && i <= folders.length; i++) {
    if (cur === anc) return true;
    cur = folders.find((f) => f.id === cur)?.parent;
  }
  return false;
}
/** Root-first chain of folders down to `id`. */
export function folderChain(folders: Folder[], id: string | null): Folder[] {
  const out: Folder[] = [];
  let cur = id;
  for (let i = 0; cur && i <= folders.length; i++) {
    const f = folders.find((x) => x.id === cur);
    if (!f) break;
    out.unshift(f);
    cur = f.parent;
  }
  return out;
}
export const folderName = (f: Folder | undefined) => f?.title.trim() || "Untitled folder";
export const isVersion = (f: Folder | undefined) => f?.kind === "version" && !f.parent;
/** Project versions, oldest first (same order as Rust's versions_of). */
export const versionsOf = (folders: Folder[]) => folders.filter(isVersion).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
/** The version a folder is in (itself when it is one); undefined at the root or without versions. */
export const versionOf = (folders: Folder[], id: string | null | undefined): Folder | undefined => {
  const top = folderChain(folders, id ?? null)[0];
  return isVersion(top) ? top : undefined;
};
/** The canvas a project opens on: its last version (the root without versions). */
const startFolder = (d: ProjectData): string | null => {
  const vs = versionsOf(d.folders);
  const v = vs.find((f) => f.id === d.meta.last_version) ?? vs[vs.length - 1];
  return v && d.canvases[v.id] ? v.id : null;
};
/** Card id -> the version it is in (cards outside versions are left out). */
export function cardVersions(d: Pick<ProjectData, "folders" | "canvases">): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, c] of Object.entries(d.canvases)) {
    const v = k ? versionOf(d.folders, k) : undefined;
    if (v) for (const id of Object.keys(c.cards)) if (!out.has(id)) out.set(id, v.id);
  }
  return out;
}
/** The next free "vN" title. */
export const nextVersionTitle = (folders: Folder[]) => `v${Math.max(0, ...versionsOf(folders).map((f) => Number(/^v\s*(\d+)$/i.exec(f.title.trim())?.[1] ?? 0))) + 1}`;
const itemSize = (kind: "cards" | "folders" | "frames", p: { w?: number; h?: number }) =>
  kind === "frames" ? { w: p.w ?? 0, h: p.h ?? 0 } : kind === "folders" ? { w: p.w ?? FOLDER_W, h: p.h ?? FOLDER_H } : { w: p.w ?? CARD_W, h: p.h ?? CARD_H };
/** Bounds of everything on a canvas (null when empty). */
function boundsOf(c: Canvas) {
  const boxes = [
    ...Object.values(c.cards).map((p) => ({ x: p.x, y: p.y, ...itemSize("cards", p) })),
    ...Object.values(c.folders ?? {}).map((p) => ({ x: p.x, y: p.y, ...itemSize("folders", p) })),
    ...Object.values(c.frames ?? {}),
  ];
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
const maxZ = (c: Canvas) => Math.max(0, ...Object.values(c.cards).map((p) => p.z ?? 0), ...Object.values(c.folders ?? {}).map((p) => p.z ?? 0));
/**
 * Takes `items` off `src` and puts them on `dst`, keeping their layout, with the group's top-left
 * at `origin`. Returns the new (src, dst); z-order is kept above everything already on `dst`.
 */
function transfer(src: Canvas, dst: Canvas, items: Items, origin: { x: number; y: number }): [Canvas, Canvas] {
  const s = { ...src, cards: { ...src.cards }, frames: { ...src.frames }, folders: { ...src.folders } };
  const d = { ...dst, cards: { ...dst.cards }, frames: { ...dst.frames }, folders: { ...dst.folders } };
  const picked = {
    cards: (items.cards ?? []).filter((id) => s.cards[id]),
    frames: (items.frames ?? []).filter((id) => s.frames[id]),
    folders: (items.folders ?? []).filter((id) => s.folders[id]),
  };
  const xs = [...picked.cards.map((id) => s.cards[id].x), ...picked.frames.map((id) => s.frames[id].x), ...picked.folders.map((id) => s.folders[id].x)];
  const ys = [...picked.cards.map((id) => s.cards[id].y), ...picked.frames.map((id) => s.frames[id].y), ...picked.folders.map((id) => s.folders[id].y)];
  if (!xs.length) return [src, dst];
  const dx = origin.x - Math.min(...xs);
  const dy = origin.y - Math.min(...ys);
  let z = maxZ(d) + 1;
  const byZ = <T extends { z?: number }>(ids: string[], m: Record<string, T>) => [...ids].sort((a, b) => (m[a].z ?? 0) - (m[b].z ?? 0));
  for (const id of byZ(picked.cards, s.cards)) {
    d.cards[id] = { ...s.cards[id], x: Math.round(s.cards[id].x + dx), y: Math.round(s.cards[id].y + dy), z: z++ };
    delete s.cards[id];
  }
  for (const id of byZ(picked.folders, s.folders)) {
    d.folders[id] = { ...s.folders[id], x: Math.round(s.folders[id].x + dx), y: Math.round(s.folders[id].y + dy), z: z++ };
    delete s.folders[id];
  }
  const fz = Math.max(0, ...Object.values(d.frames).map((f) => f.z)) + 1;
  picked.frames.forEach((id, i) => {
    d.frames[id] = { ...s.frames[id], x: Math.round(s.frames[id].x + dx), y: Math.round(s.frames[id].y + dy), z: fz + i };
    delete s.frames[id];
  });
  return [s, d];
}
/** Where a group lands on a canvas that already has things on it: to the right of them. */
function freeSpot(c: Canvas): { x: number; y: number } {
  const b = boundsOf(c);
  return b ? { x: Math.round(b.x + b.w + 80), y: Math.round(b.y) } : { x: 0, y: 0 };
}

const stampNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const STAGE_ORDER = ["mist", "reverie", "lucid", "dream", "built"];

/** Target positions for an arrange op: groups side by side, each a grid (or one column). */
function layoutCards(list: string[], c: Canvas, byId: Map<string, Card>, layout: OrganizeLayout): Record<string, { x: number; y: number }> {
  const ps = list.map((id) => c.cards[id]);
  const ox = Math.min(...ps.map((p) => p.x));
  const oy = Math.min(...ps.map((p) => p.y));
  const cw = Math.max(...ps.map((p) => p.w ?? CARD_W)) + 40;
  const ch = Math.max(...ps.map((p) => p.h ?? CARD_H + 60)) + 40;
  // Reading order of where they sit now, so a re-layout keeps them roughly in place.
  const sorted = [...list].sort((a, b) => Math.round(c.cards[a].y / 100) - Math.round(c.cards[b].y / 100) || c.cards[a].x - c.cards[b].x);
  const square = (n: number) => Math.max(1, Math.ceil(Math.sqrt(n)));
  let groups: string[][];
  let colsOf: (n: number) => number = () => 1;
  if (layout === "grid") {
    groups = [sorted];
    colsOf = square;
  } else if (layout === "cluster-by-tag") {
    const freq = new Map<string, number>();
    for (const id of sorted) for (const t of byId.get(id)?.tags ?? []) freq.set(t, (freq.get(t) ?? 0) + 1);
    const tagOf = (id: string) => [...(byId.get(id)?.tags ?? [])].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b))[0] ?? "";
    const by = new Map<string, string[]>();
    for (const id of sorted) by.set(tagOf(id), [...(by.get(tagOf(id)) ?? []), id]);
    groups = [...by.entries()].sort((a, b) => (a[0] === "" ? 1 : 0) - (b[0] === "" ? 1 : 0) || b[1].length - a[1].length).map(([, g]) => g);
    colsOf = (n) => Math.min(3, square(n));
  } else if (layout === "stage-columns") {
    groups = STAGE_ORDER.map((st) => sorted.filter((id) => byId.get(id)?.stage === st)).filter((g) => g.length);
    const rest = sorted.filter((id) => !STAGE_ORDER.includes(byId.get(id)?.stage ?? ""));
    if (rest.length) groups.push(rest);
  } else {
    // flow-by-links: a card sits one column right of the furthest card linking to it.
    const inSet = new Set(sorted);
    const depth = new Map(sorted.map((id) => [id, 0]));
    for (let pass = 0; pass < sorted.length; pass++) {
      let changed = false;
      for (const a of sorted) {
        for (const l of byId.get(a)?.links ?? []) {
          const d = depth.get(a)! + 1;
          if (inSet.has(l.to) && d < sorted.length && d > depth.get(l.to)!) {
            depth.set(l.to, d);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    const max = Math.max(0, ...depth.values());
    groups = Array.from({ length: max + 1 }, (_, d) => sorted.filter((id) => depth.get(id) === d)).filter((g) => g.length);
  }
  const out: Record<string, { x: number; y: number }> = {};
  let x = ox;
  for (const g of groups) {
    const cols = colsOf(g.length);
    g.forEach((id, i) => (out[id] = { x: Math.round(x + (i % cols) * cw), y: Math.round(oy + Math.floor(i / cols) * ch) }));
    x += Math.min(cols, g.length) * cw + 80;
  }
  return out;
}

/** What an organize plan does to a structure (pure: the canvas preview and Apply share it). */
export interface OrganizeSim {
  structure: Structure;
  /** Ops that take effect: checked, and every folder they need is made. */
  effective: boolean[];
  /** Card / folder id -> the canvas key it moves to. */
  moved: Record<string, string>;
  /** Re-laid-out card ids. */
  arranged: Set<string>;
  /** Cards whose tags change, with their new lists. */
  tags: { id: string; tags: string[] }[];
  /** tempId -> the id it got. */
  ids: Record<string, string>;
}

/** Runs the checked ops of `plan` on `s0`. An op naming a folder whose create op is off is skipped. */
export function simulateOrganize(s0: Structure, cards: Card[], plan: OrganizePlanData, checked: boolean[], idFor: (tempId: string, kind: "folder" | "frame") => string): OrganizeSim {
  let s: Structure = { canvases: { ...s0.canvases }, folders: s0.folders };
  const ids: Record<string, string> = {};
  const dead = new Set<string>();
  const byId = new Map(cards.map((c) => [c.id, c]));
  const effective = plan.ops.map(() => false);
  const moved: Record<string, string> = {};
  const arranged = new Set<string>();
  const tagMap = new Map<string, string[]>();
  /** A folder ref -> its canvas key, or undefined when it doesn't exist (or its create op is off). */
  const ref = (r: string | null | undefined): string | undefined => {
    if (r == null || r === "") return ROOT;
    if (dead.has(r)) return undefined;
    const k = ids[r] ?? r;
    return s.canvases[k] ? k : undefined;
  };
  const setCanvas = (k: string, c: Canvas) => (s = { ...s, canvases: { ...s.canvases, [k]: c } });
  plan.ops.forEach((op, i) => {
    const on = checked[i] !== false;
    if (op.op === "create_folder") {
      const parent = ref(op.parent);
      if (!on || parent === undefined) return void dead.add(op.tempId);
      const id = idFor(op.tempId, "folder");
      ids[op.tempId] = id;
      const pc = s.canvases[parent];
      const at = freeSpot(pc);
      const t = stampNow();
      s = {
        canvases: { ...s.canvases, [parent]: { ...pc, folders: { ...pc.folders, [id]: { x: at.x, y: at.y, z: maxZ(pc) + 1 } } }, [id]: blankCanvas() },
        folders: [...s.folders, { id, title: op.title, parent: parent || null, created: t, updated: t, ...(op.color ? { color: op.color } : {}) }],
      };
    } else if (op.op === "rename") {
      if (!on || dead.has(op.id)) return;
      const id = ids[op.id] ?? op.id;
      if (s.folders.some((f) => f.id === id)) s = { ...s, folders: s.folders.map((f) => (f.id === id ? { ...f, title: op.title, updated: stampNow() } : f)) };
      else {
        const k = Object.keys(s.canvases).find((x) => s.canvases[x].frames[id]);
        if (k === undefined) return;
        const c = s.canvases[k];
        setCanvas(k, { ...c, frames: { ...c.frames, [id]: { ...c.frames[id], title: op.title } } });
      }
    } else if (op.op === "move") {
      const to = ref(op.to);
      if (!on || to === undefined) return;
      const groups = new Map<string, { cards: string[]; folders: string[] }>();
      const group = (k: string) => groups.get(k) ?? (groups.set(k, { cards: [], folders: [] }), groups.get(k)!);
      for (const raw of op.ids) {
        const id = ids[raw] ?? raw;
        const f = s.folders.find((x) => x.id === id);
        if (f) {
          const k = keyOf(f.parent);
          if (k !== to && !(to && isInside(s.folders, to, id)) && s.canvases[k]?.folders[id]) group(k).folders.push(id);
        } else {
          const k = Object.keys(s.canvases).find((x) => s.canvases[x].cards[id]);
          if (k !== undefined && k !== to) group(k).cards.push(id);
        }
      }
      let origin = op.x != null && op.y != null ? { x: op.x, y: op.y } : null;
      for (const [k, items] of groups) {
        const [src, dst] = transfer(s.canvases[k], s.canvases[to], items, origin ?? freeSpot(s.canvases[to]));
        s = { canvases: { ...s.canvases, [k]: src, [to]: dst }, folders: s.folders.map((f) => (items.folders.includes(f.id) ? { ...f, parent: to || null, updated: stampNow() } : f)) };
        for (const id of [...items.cards, ...items.folders]) moved[id] = to;
        origin = null;
      }
    } else if (op.op === "create_frame") {
      const k = ref(op.folder);
      if (!on || k === undefined) return void dead.add(op.tempId);
      const id = idFor(op.tempId, "frame");
      ids[op.tempId] = id;
      const c = s.canvases[k];
      const z = Math.max(-1, ...Object.values(c.frames).map((f) => f.z)) + 1;
      setCanvas(k, { ...c, frames: { ...c.frames, [id]: { ...op.rect, title: op.title, z } } });
    } else if (op.op === "arrange") {
      const k = ref(op.folder);
      if (!on || k === undefined) return;
      const c = s.canvases[k];
      const list = op.ids.filter((id) => c.cards[id] && !c.cards[id].pinned);
      if (!list.length) return;
      const pos = layoutCards(list, c, byId, op.layout);
      const next = { ...c.cards };
      for (const [id, p] of Object.entries(pos)) next[id] = { ...next[id], ...p };
      setCanvas(k, { ...c, cards: next });
      list.forEach((id) => arranged.add(id));
    } else if (op.op === "place") {
      // Explicit positions (the organize pipeline's own layout); pinned cards never move.
      const k = ref(op.folder);
      if (!on || k === undefined) return;
      const c = s.canvases[k];
      const next = { ...c.cards };
      let n = 0;
      for (const [id, p] of Object.entries(op.positions)) {
        if (!c.cards[id] || c.cards[id].pinned) continue;
        next[id] = { ...next[id], x: p.x, y: p.y };
        arranged.add(id);
        n++;
      }
      if (!n) return;
      setCanvas(k, { ...c, cards: next });
    } else if (op.op === "retag") {
      const card = byId.get(op.id);
      if (!on || !card) return;
      const cur = tagMap.get(op.id) ?? card.tags;
      tagMap.set(op.id, [...cur.filter((t) => !op.remove.includes(t)), ...op.add.filter((t) => !cur.includes(t))]);
    }
    effective[i] = true;
  });
  const tags = [...tagMap].filter(([id, t]) => t.join("\n") !== (byId.get(id)?.tags ?? []).join("\n")).map(([id, t]) => ({ id, tags: t }));
  return { structure: s, effective, moved, arranged, tags, ids };
}

/** The plan card that's open in chat: the canvas previews it (hover = one op's items). */
export interface OrganizePreview {
  plan: OrganizePlanData;
  checked: boolean[];
  hover: number | null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A link Claude proposed (via /related). Lives only in memory until the user clicks Keep, which
 * writes a real link to the card file; Dismiss drops it. Never written to disk as a proposal.
 */
export interface GhostLink {
  key: string;
  slug: string;
  from: string;
  to: string;
  label?: string;
  reason?: string;
}

/** A request for the canvas to pan/zoom to a card (from a search chip or Ctrl+K). */
export interface FocusRequest {
  id: string;
  slug: string;
  n: number;
}

/** Text for the chat panel: `send` sends it as a turn, otherwise it fills and focuses the input. */
export interface ChatRequest {
  text: string;
  display?: string;
  send?: boolean;
  /** Thread to use: a card id, or null for the project thread. Absent = the current thread. */
  thread?: string | null;
  /** With `display`: show only a typing indicator while Claude answers (grill-me style turns). */
  quiet?: boolean;
  /** An artifact turn on Claude in that artifact's thread (create, chip, regenerate). */
  artifact?: string;
  /** The chat thread an artifact request came from: its recap goes along. */
  recapFrom?: string;
  /** Wait while Claude is busy (e.g. the chat turn that asked for it is still finishing). */
  wait?: boolean;
  n: number;
}

/** Opens the handoff pack dialog ("Summarize") with this scope preselected. */
export interface HandoffRequest {
  scope: HandoffScope;
  n: number;
}

/** Opens "Make build prompt" for the cards a scope covers (a card, a selection, a frame, a version). */
export interface TaskRequest {
  scope: HandoffScope;
  n: number;
}

export type VersionDialog = { kind: "new"; from?: string } | { kind: "rename"; id: string } | { kind: "compare"; a?: string; b?: string; card?: string };

interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** The folder that was open when it happened: undo/redo go back there first. */
  folder?: string | null;
}

/** Workspace state for the UI: project list, active project, its cards. Reloads when files change on disk. */
export function useWorkspace() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [data, setData] = useState<ProjectData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNoticeText] = useState<string | null>(null);
  /** The current notice offers an Undo button (e.g. after deleting cards). */
  const [noticeUndo, setNoticeUndo] = useState(false);
  const setNotice = useCallback((n: string | null) => {
    setNoticeText(n);
    setNoticeUndo(false);
  }, []);
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [contextCardId, setContextCardId] = useState<string | null>(null);
  /** Card ids selected on the canvas (kept in sync by CanvasArea; read by the chat per turn). */
  const canvasSelection = useRef<string[]>([]);
  const setCanvasSelection = useCallback((ids: string[]) => void (canvasSelection.current = ids), []);
  const getCanvasSelection = useCallback(() => canvasSelection.current, []);
  const [ghostLinks, setGhostLinks] = useState<GhostLink[]>([]);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusSeq = useRef(0);
  const [chatRequest, setChatRequest] = useState<ChatRequest | null>(null);
  const chatSeq = useRef(0);
  const [handoffRequest, setHandoffRequest] = useState<HandoffRequest | null>(null);
  const handoffSeq = useRef(0);
  const [taskRequest, setTaskRequest] = useState<TaskRequest | null>(null);
  /** The Design view (handoff pack reader) is open for the active project. */
  const [designOpen, setDesignOpen] = useState(false);
  /** A project-version dialog (Versions.tsx): new, rename, compare (optionally of one card). */
  const [versionDialog, setVersionDialog] = useState<VersionDialog | null>(null);
  /** The Memory modal is open for the active project. */
  const [memoryOpen, setMemoryOpen] = useState(false);
  const activeRef = useRef<string | null>(null);
  /** The folder whose canvas is shown (null = the project root). */
  const [folder, setFolderState] = useState<string | null>(null);
  const folderRef = useRef<string | null>(null);
  /** Linking mode (the Link tool or L): survives moving between folders, so a link can cross them. */
  const [linkMode, setLinkModeState] = useState(false);
  const [linkFrom, setLinkFromState] = useState<string | null>(null);
  const setLinking = useCallback((on: boolean, from: string | null = null) => {
    setLinkModeState(on);
    setLinkFromState(on ? from : null);
  }, []);
  /** Canvases changed since the last save (keys of `canvases`). */
  const dirty = useRef(new Set<string>());
  const dataRef = useRef<ProjectData | null>(null);
  /** A merge ghost's originals that are still on the canvas. */
  /** The values `patch` overwrites on `before`, for undo. A list that was absent comes back as [] (absent would not clear it). */
  const prevOf = (before: Card, patch: CardPatch): CardPatch => {
    const prev: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      const v = (before as Record<string, unknown>)[k];
      prev[k] = v === undefined && Array.isArray((patch as Record<string, unknown>)[k]) ? [] : v;
    }
    return prev as CardPatch;
  };
  const liveOriginals = (c: Card) => (c.merged_from ?? []).filter((o) => dataRef.current?.cards.some((x) => x.id === o));
  const loadSeq = useRef(0);
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const canvasSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Watcher events before this time (performance.now) are echoes of our own canvas save. */
  const selfWriteUntil = useRef(0);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      const slug = activeRef.current;
      if (!slug) return;
      const seq = ++loadSeq.current;
      try {
        const d = withRoot(await api.loadProject(slug));
        if (seq === loadSeq.current && activeRef.current === slug) {
          // The persisted viewport applies only on first load; after that the live camera wins, so
          // a reload (our own save echoing through the watcher, or any edit) never moves the view.
          const live = dataRef.current;
          if (live && live.slug === slug) {
            for (const [k, c] of Object.entries(d.canvases)) if (live.canvases[k]) d.canvases[k] = { ...c, viewport: live.canvases[k].viewport };
          }
          // The open folder went away (deleted, or by hand): back to the nearest folder that's left.
          // First load of a project: its last version.
          let f = live && live.slug === slug ? folderRef.current : startFolder(d);
          const was = f;
          while (f && !d.canvases[f]) f = live?.folders.find((x) => x.id === f)?.parent ?? null;
          if (f === null && was !== null) f = startFolder(d);
          if (f !== folderRef.current) {
            folderRef.current = f;
            setFolderState(f);
          }
          const next = viewOf(d, f);
          dataRef.current = next;
          setData(next);
        }
      } catch (e) {
        // The active project vanished (deleted on disk): fall back to the Inbox.
        if (list.some((p) => p.slug === INBOX) && slug !== INBOX) {
          activeRef.current = INBOX;
          setActive(INBOX);
          const raw = withRoot(await api.loadProject(INBOX));
          folderRef.current = startFolder(raw);
          setFolderState(folderRef.current);
          const d = viewOf(raw, folderRef.current);
          dataRef.current = d;
          setData(d);
        } else throw e;
      }
    } catch (e) {
      setError(message(e));
    }
  }, []);

  const select = useCallback(
    async (slug: string) => {
      activeRef.current = slug;
      setActive(slug);
      folderRef.current = null;
      setFolderState(null);
      setLinking(false);
      dirty.current.clear();
      dataRef.current = null;
      setData(null);
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);
      api.updateSettings({ last_project: slug }).catch(() => {});
      await refresh();
    },
    [refresh, setLinking],
  );

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, list] = await Promise.all([api.getSettings(), api.listProjects()]);
        if (cancelled) return;
        const start =
          list.find((p) => p.slug === settings.last_project)?.slug ??
          list.find((p) => !p.is_inbox)?.slug ??
          INBOX;
        activeRef.current = start;
        setActive(start);
        setProjects(list);
        const raw = withRoot(await api.loadProject(start));
        folderRef.current = startFolder(raw);
        setFolderState(folderRef.current);
        const d = viewOf(raw, folderRef.current);
        dataRef.current = d;
        setData(d);
      } catch (e) {
        setError(message(e));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live updates from disk.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsub: (() => void) | undefined;
    let disposed = false;
    api
      .onChange((events) => {
        // Echo of our own canvas.json write: nothing to reload.
        // memory.md and its log have their own listeners (the Memory modal); the canvas ignores them.
        if (events.every((e) => e.scope === "memory" || e.scope === "artifact")) return;
        if (performance.now() < selfWriteUntil.current && events.every((e) => e.scope === "project" && e.project === activeRef.current)) return;
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 120);
      })
      .then((u) => (disposed ? u() : (unsub = u)))
      .catch((e) => setError(message(e)));
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsub?.();
    };
  }, [refresh]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        const r = await fn();
        await refresh();
        return r;
      } catch (e) {
        setError(message(e));
        return undefined;
      }
    },
    [refresh],
  );

  /** Shows a folder's canvas (null = the root). Pending canvas edits are saved first. */
  const openFolderRef = useRef<(id: string | null) => void>(() => {});
  const pushUndo = useCallback((entry: UndoEntry) => {
    if (entry.folder === undefined) entry.folder = folderRef.current;
    undoStack.current.push(entry);
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  /** Undo/redo first go back to the canvas the step happened on (when it still exists). */
  const goTo = (f: string | null | undefined) => {
    if (f === undefined || f === folderRef.current) return;
    if (f === null || dataRef.current?.canvases[f]) openFolderRef.current(f);
  };
  const undo = useCallback(async () => {
    const entry = undoStack.current.pop();
    setCanUndo(undoStack.current.length > 0);
    if (!entry) return;
    try {
      goTo(entry.folder);
      await entry.undo();
      redoStack.current.push(entry);
      setCanRedo(true);
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  }, [refresh]);

  const redo = useCallback(async () => {
    const entry = redoStack.current.pop();
    setCanRedo(redoStack.current.length > 0);
    if (!entry) return;
    try {
      goTo(entry.folder);
      await entry.redo();
      undoStack.current.push(entry);
      setCanUndo(true);
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  }, [refresh]);

  // ----- canvas: pan/zoom + drag, persisted with a short debounce -----

  // dataRef is updated synchronously here (not only by the effect after render), so a
  // flushCanvas() right after a patch saves the patched canvas, not the previous one.
  const patchCanvas = useCallback((fn: (c: Canvas) => Canvas) => {
    const prev = dataRef.current;
    if (!prev) return;
    const key = keyOf(folderRef.current);
    const canvas = fn(prev.canvas);
    const next = { ...prev, canvas, canvases: { ...prev.canvases, [key]: canvas } };
    dirty.current.add(key);
    dataRef.current = next;
    setData(next);
  }, []);

  /** Saves every canvas changed since the last save (the open one when none is marked). */
  const flushCanvas = useCallback(async () => {
    clearTimeout(canvasSaveTimer.current);
    const slug = activeRef.current;
    const d = dataRef.current;
    if (!slug || !d) return;
    const keys = dirty.current.size ? [...dirty.current] : [keyOf(folderRef.current)];
    dirty.current.clear();
    selfWriteUntil.current = performance.now() + 800;
    for (const k of keys) {
      const c = d.canvases[k];
      if (c) await api.saveCanvas(slug, c, k || null).catch((e) => setError(message(e)));
    }
    selfWriteUntil.current = performance.now() + 500;
  }, []);

  const openFolder = useCallback(
    (id: string | null) => {
      const d = dataRef.current;
      if (!d || (id && !d.canvases[id]) || id === folderRef.current) return;
      void flushCanvas();
      // Into another version: it becomes the one that opens next time (and the one Claude works in).
      const v = versionOf(d.folders, id);
      const switched = v && v.id !== d.meta.last_version;
      if (switched && activeRef.current) api.updateProject(activeRef.current, { last_version: v.id }).catch(() => {});
      folderRef.current = id;
      setFolderState(id);
      const next = viewOf(switched ? { ...d, meta: { ...d.meta, last_version: v.id } } : d, id);
      dataRef.current = next;
      setData(next);
    },
    [flushCanvas],
  );
  openFolderRef.current = openFolder;

  const scheduleCanvasSave = useCallback(() => {
    clearTimeout(canvasSaveTimer.current);
    canvasSaveTimer.current = setTimeout(flushCanvas, CANVAS_SAVE_DEBOUNCE_MS);
  }, [flushCanvas]);

  useEffect(() => () => void flushCanvas(), [flushCanvas]);

  const setViewport = useCallback(
    (vp: { x: number; y: number; zoom: number }) => {
      patchCanvas((c) => ({ ...c, viewport: vp }));
      scheduleCanvasSave();
    },
    [patchCanvas, scheduleCanvasSave],
  );

  /** Merge into a card's canvas entry (keeps size and z-order when only x/y change). */
  const patchPos = useCallback(
    (id: string, patch: Partial<Pos>) => patchCanvas((c) => (c.cards[id] ? { ...c, cards: { ...c.cards, [id]: { ...c.cards[id], ...patch } } } : c)),
    [patchCanvas],
  );

  /** Pushes an undo entry that restores a card's whole canvas entry. */
  const pushPosUndo = useCallback(
    (label: string, id: string, before: Pos, after: Pos) => {
      pushUndo({
        label,
        undo: async () => {
          patchCanvas((c) => ({ ...c, cards: { ...c.cards, [id]: before } }));
          await flushCanvas();
        },
        redo: async () => {
          patchCanvas((c) => ({ ...c, cards: { ...c.cards, [id]: after } }));
          await flushCanvas();
        },
      });
    },
    [patchCanvas, flushCanvas, pushUndo],
  );

  const moveCard = useCallback(
    (id: string, pos: Pos, opts?: { undoable?: boolean; from?: Pos }) => {
      patchPos(id, { x: pos.x, y: pos.y });
      scheduleCanvasSave();
      // `from` must be the position at drag-start, passed by the caller: by the time a drag ends,
      // `dataRef` already holds the dragged-to position (every intermediate move went through here
      // too), so reading "the previous position" from state at this point would just be `pos` again.
      if (opts?.undoable && opts.from) {
        const from = opts.from;
        pushUndo({
          label: "move card",
          undo: async () => {
            patchPos(id, { x: from.x, y: from.y });
            await flushCanvas();
          },
          redo: async () => {
            patchPos(id, { x: pos.x, y: pos.y });
            await flushCanvas();
          },
        });
      }
    },
    [patchPos, scheduleCanvasSave, flushCanvas, pushUndo],
  );

  /**
   * Resize: `rect` may move x/y too (dragging a top/left handle). Live calls during a drag just
   * patch state; the final call passes `{ undoable, from }` (the Pos at drag start).
   */
  const resizeCard = useCallback(
    (id: string, rect: { x: number; y: number; w: number; h?: number }, opts?: { undoable?: boolean; from?: Pos }) => {
      patchPos(id, rect);
      if (opts?.undoable && opts.from) {
        const before = opts.from;
        const after = { ...before, ...rect };
        void flushCanvas();
        pushPosUndo("resize card", id, before, after);
      } else scheduleCanvasSave();
    },
    [patchPos, scheduleCanvasSave, flushCanvas, pushPosUndo],
  );

  /** Bring to front / send to back (cards and folder nodes share one order). No-op (and no undo entry) when nothing would change. */
  const setStacking = useCallback(
    (id: string, where: "front" | "back", kind: "cards" | "folders" = "cards") => {
      const c = dataRef.current?.canvas;
      const before = c?.[kind]?.[id];
      if (!c || !before) return;
      const others = [...Object.entries(c.cards), ...Object.entries(c.folders ?? {})].filter(([k]) => k !== id).map(([, p]) => p.z ?? 0);
      const top = others.length ? Math.max(...others) : 0;
      const bottom = others.length ? Math.min(...others) : 0;
      const after: Pos =
        where === "front" ? { ...before, z: top + 1, back: undefined } : { ...before, z: bottom - 1, back: true };
      if (where === "front" && !before.back && (before.z ?? 0) > top) return;
      if (where === "back" && before.back && (before.z ?? 0) < bottom) return;
      if (kind === "folders") {
        const snap = layoutOf(c);
        patchCanvas((cv) => ({ ...cv, folders: { ...cv.folders, [id]: after } }));
        commitLayoutRef.current(where === "front" ? "bring to front" : "send to back", snap);
        return;
      }
      patchCanvas((cv) => ({ ...cv, cards: { ...cv.cards, [id]: after } }));
      void flushCanvas();
      pushPosUndo(where === "front" ? "bring to front" : "send to back", id, before, after);
    },
    [patchCanvas, flushCanvas, pushPosUndo],
  );
  const commitLayoutRef = useRef<(label: string, before: Layout) => void>(() => {});
  const bringToFront = useCallback((id: string) => setStacking(id, "front"), [setStacking]);
  // ----- frames: every committed change is one undo step restoring positions + frames -----

  const pushLayoutUndo = useCallback(
    (label: string, before: Layout, after: Layout) => {
      const apply = (l: Layout) => async () => {
        patchCanvas((c) => ({ ...c, ...l }));
        await flushCanvas();
      };
      pushUndo({ label, undo: apply(before), redo: apply(after) });
    },
    [patchCanvas, flushCanvas, pushUndo],
  );

  /** Snapshot for a gesture's undo entry (take it at gesture start). */
  const layoutSnapshot = useCallback((): Layout | null => (dataRef.current ? layoutOf(dataRef.current.canvas) : null), []);

  /** Live frame change during a drag (no undo, debounced save). `cardMoves` moves member cards with it. */
  const patchFrameLive = useCallback(
    (id: string, patch: Partial<Frame>, cardMoves?: Record<string, { x: number; y: number }>) => {
      patchCanvas((c) => {
        const f = c.frames?.[id];
        if (!f) return c;
        let cards = c.cards;
        if (cardMoves) {
          cards = { ...cards };
          for (const [cid, p] of Object.entries(cardMoves)) if (cards[cid]) cards[cid] = { ...cards[cid], x: p.x, y: p.y };
        }
        return { ...c, cards, frames: { ...c.frames, [id]: { ...f, ...patch } } };
      });
      scheduleCanvasSave();
    },
    [patchCanvas, scheduleCanvasSave],
  );

  /** End of a frame gesture: save now and push one undo entry back to `before`. */
  const commitLayout = useCallback(
    (label: string, before: Layout) => {
      const d = dataRef.current;
      if (!d) return;
      const after = layoutOf(d.canvas);
      if (after.cards === before.cards && after.frames === before.frames && after.folders === before.folders) return;
      void flushCanvas();
      pushLayoutUndo(label, before, after);
    },
    [flushCanvas, pushLayoutUndo],
  );
  commitLayoutRef.current = commitLayout;

  /** Live folder-node change during a drag or resize (no undo, debounced save). */
  const patchFolderLive = useCallback(
    (id: string, patch: Partial<Pos>) => {
      patchCanvas((c) => (c.folders?.[id] ? { ...c, folders: { ...c.folders, [id]: { ...c.folders[id], ...patch } } } : c));
      scheduleCanvasSave();
    },
    [patchCanvas, scheduleCanvasSave],
  );

  /** Pin or unpin a card's or folder's position (one undo step). */
  const setPinned = useCallback(
    (kind: "cards" | "folders", id: string, pinned: boolean) => {
      const before = layoutSnapshot();
      if (!before?.[kind][id]) return;
      patchCanvas((c) => ({ ...c, [kind]: { ...c[kind], [id]: { ...c[kind][id], pinned: pinned || undefined } } }));
      commitLayout(pinned ? "pin position" : "unpin position", before);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchCanvas, commitLayout],
  );

  // ----- folders: every structural change (records + canvases) is one undo step -----

  const structure = useCallback((): Structure | null => {
    const d = dataRef.current;
    return d ? { canvases: d.canvases, folders: d.folders } : null;
  }, []);

  /** Puts a structure in place (keeping each canvas's live camera) and writes what changed in one call. */
  const applyStructure = useCallback(async (s: Structure) => {
    const d = dataRef.current;
    const slug = activeRef.current;
    if (!d || !slug) return;
    const canvases: Record<string, Canvas> = {};
    const changed: Record<string, Canvas> = {};
    for (const [k, c] of Object.entries(s.canvases)) {
      canvases[k] = d.canvases[k] ? { ...c, viewport: d.canvases[k].viewport } : c;
      if (d.canvases[k] !== c || dirty.current.has(k)) changed[k] = canvases[k];
    }
    let f = folderRef.current;
    while (f && !canvases[f]) f = d.folders.find((x) => x.id === f)?.parent ?? null;
    if (f !== folderRef.current) {
      folderRef.current = f;
      setFolderState(f);
    }
    clearTimeout(canvasSaveTimer.current);
    dirty.current.clear();
    const next = viewOf({ ...d, canvases, folders: s.folders }, f);
    dataRef.current = next;
    setData(next);
    selfWriteUntil.current = performance.now() + 800;
    await api.saveLayout(slug, { canvases: changed, ...(s.folders !== d.folders ? { folders: s.folders } : {}) }).catch((e) => setError(message(e)));
    selfWriteUntil.current = performance.now() + 500;
  }, []);

  /** Applies `fn` to the current structure as one undo step (`before` overrides the undo target, e.g. the state at drag start). */
  const changeStructure = useCallback(
    (label: string, fn: (s: Structure) => Structure | null, before?: Structure | null) => {
      const cur = structure();
      if (!cur) return false;
      const after = fn(cur);
      if (!after) return false;
      const back = before ?? cur;
      void applyStructure(after);
      pushUndo({ label, undo: () => applyStructure(back), redo: () => applyStructure(after) });
      return true;
    },
    [structure, applyStructure, pushUndo],
  );

  const stamp = stampNow;

  const [organizePreview, setOrganizePreview] = useState<OrganizePreview | null>(null);

  /** Applies the checked ops of a plan as ONE undo step (the folder layout in one write, then tags). */
  const applyOrganize = useCallback(
    async (plan: OrganizePlanData, checked: boolean[]) => {
      const slug = activeRef.current;
      if (!slug || plan.slug !== slug) {
        setNotice("Open that project to apply its plan.");
        return false;
      }
      await flushCanvas();
      const cur = structure();
      const d = dataRef.current;
      if (!cur || !d) return false;
      const sim = simulateOrganize(cur, d.cards, plan, checked, (_t, kind) => (kind === "frame" ? newFrameId() : newFolderId()));
      if (!sim.effective.some(Boolean)) return false;
      const before = sim.tags.map((e) => ({ id: e.id, tags: d.cards.find((c) => c.id === e.id)?.tags ?? [] }));
      const label = `Claude organized ${plan.scopeName}`;
      const setTags = async (list: { id: string; tags: string[] }[]) => {
        for (const e of list) await api.updateCard(slug, e.id, { tags: e.tags });
        if (list.length) await refresh();
      };
      const forward = async () => {
        await applyStructure(sim.structure);
        await setTags(sim.tags);
      };
      try {
        await forward();
      } catch (e) {
        setError(message(e));
        return false;
      }
      pushUndo({
        label,
        undo: async () => {
          await applyStructure(cur);
          await setTags(before);
        },
        redo: forward,
      });
      setNotice(`${label}.`);
      setNoticeUndo(true);
      return true;
    },
    [flushCanvas, structure, applyStructure, refresh, pushUndo, setNotice],
  );

  /** Hides the "Tidy this folder?" hint for a folder (null = the root) for good. Not an undo step. */
  const setNudgeOff = useCallback(
    async (folder: string | null) => {
      const d = dataRef.current;
      const slug = activeRef.current;
      if (!d || !slug) return;
      if (folder) {
        const s = structure();
        if (s) await applyStructure({ ...s, folders: s.folders.map((f) => (f.id === folder ? { ...f, nudge_off: true } : f)) });
        return;
      }
      const next = { ...d, meta: { ...d.meta, nudge_off: true } };
      dataRef.current = next;
      setData(next);
      await api.updateProject(slug, { nudge_off: true }).catch((e) => setError(message(e)));
    },
    [structure, applyStructure],
  );

  /**
   * New folder on the open canvas. With `group`, those items move into it (their layout kept) and
   * the folder takes the group's place. Returns the folder id.
   */
  const createFolder = useCallback(
    (at: { x: number; y: number } | null, title = "New folder", group?: Items, extra?: Partial<Folder>): string | null => {
      const id = newFolderId();
      const key = keyOf(folderRef.current);
      // The top level of a versioned project holds only versions: a folder there is a new, empty version.
      if (!folderRef.current && versionsOf(dataRef.current?.folders ?? []).length) {
        if (group) {
          setNotice("Versions can't be grouped. Open a version to make folders inside it.");
          return null;
        }
        extra = { ...extra, kind: "version" };
        if (title === "New folder") title = nextVersionTitle(dataRef.current!.folders);
      }
      const ok = changeStructure(group ? "group into folder" : "new folder", (s) => {
        const cur = s.canvases[key];
        let [outer, inner] = [cur, blankCanvas()];
        let pos = at ?? freeSpot(cur);
        if (group && (group.cards?.length || group.frames?.length || group.folders?.length)) {
          const pts = [...(group.cards ?? []).map((g) => cur.cards[g]), ...(group.folders ?? []).map((g) => cur.folders[g]), ...(group.frames ?? []).map((g) => cur.frames[g])].filter(Boolean);
          if (!at && pts.length) pos = { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) };
          [outer, inner] = transfer(cur, inner, group, { x: 0, y: 0 });
        }
        const t = stamp();
        const rec: Folder = { id, title, parent: folderRef.current, created: t, updated: t, ...extra };
        outer = { ...outer, folders: { ...outer.folders, [id]: { x: Math.round(pos.x), y: Math.round(pos.y), z: maxZ(outer) + 1 } } };
        const folders = s.folders.map((f) => (group?.folders?.includes(f.id) ? { ...f, parent: id } : f));
        return { canvases: { ...s.canvases, [key]: outer, [id]: inner }, folders: [...folders, rec] };
      });
      return ok ? id : null;
    },
    [changeStructure, setNotice],
  );

  /**
   * Moves items from the open canvas to folder `to` (null = the root), keeping their layout.
   * A folder never goes into itself or below itself. `before` = the structure at drag start.
   */
  const moveItems = useCallback(
    (items: Items, to: string | null, opts?: { before?: Structure | null; at?: { x: number; y: number } }) => {
      const from = keyOf(folderRef.current);
      const toKey = keyOf(to);
      const d = dataRef.current;
      if (!d || from === toKey || (to && !d.canvases[to])) return false;
      if (!to && versionsOf(d.folders).length) {
        setNotice("The project's top level holds only versions; drop into a version instead.");
        return false;
      }
      if (to && (items.folders ?? []).some((f) => isInside(d.folders, to, f))) {
        setNotice("A folder can't go inside itself.");
        return false;
      }
      const n = (items.cards?.length ?? 0) + (items.folders?.length ?? 0) + (items.frames?.length ?? 0);
      if (!n) return false;
      const ok = changeStructure(
        n === 1 ? "move into folder" : `move ${n} items`,
        (s) => {
          const [src, dst] = transfer(s.canvases[from], s.canvases[toKey], items, opts?.at ?? freeSpot(s.canvases[toKey]));
          const folders = s.folders.map((f) => (items.folders?.includes(f.id) ? { ...f, parent: to, updated: stamp() } : f));
          return { canvases: { ...s.canvases, [from]: src, [toKey]: dst }, folders };
        },
        opts?.before,
      );
      if (ok) {
        const name = to ? folderName(d.folders.find((f) => f.id === to)) : d.meta.name;
        setNotice(`Moved ${n === 1 ? "1 item" : `${n} items`} to ${name}.`);
        setNoticeUndo(true);
      }
      return ok;
    },
    [changeStructure, setNotice],
  );

  /** Re-parents a folder from anywhere (sidebar tree drag): its node moves to the new parent's canvas. */
  const reparentFolder = useCallback(
    (id: string, to: string | null) => {
      const d = dataRef.current;
      const f = d?.folders.find((x) => x.id === id);
      if (!d || !f || f.parent === to) return false;
      if (!to && versionsOf(d.folders).length) {
        setNotice("The project's top level holds only versions; drop the folder into a version.");
        return false;
      }
      if (to && isInside(d.folders, to, id)) {
        setNotice("A folder can't go inside itself.");
        return false;
      }
      return changeStructure("move folder", (s) => {
        const [src, dst] = transfer(s.canvases[keyOf(f.parent)], s.canvases[keyOf(to)], { folders: [id] }, freeSpot(s.canvases[keyOf(to)]));
        return { canvases: { ...s.canvases, [keyOf(f.parent)]: src, [keyOf(to)]: dst }, folders: s.folders.map((x) => (x.id === id ? { ...x, parent: to, updated: stamp() } : x)) };
      });
    },
    [changeStructure, setNotice],
  );

  const updateFolder = useCallback(
    (id: string, patch: Partial<Pick<Folder, "title" | "color" | "nudge_off">>, label = "edit folder") =>
      changeStructure(label, (s) => (s.folders.some((f) => f.id === id) ? { ...s, folders: s.folders.map((f) => (f.id === id ? { ...f, ...patch, updated: stamp() } : f)) } : null)),
    [changeStructure],
  );

  /** Contents move up to the parent canvas where the folder was; the empty folder goes. */
  const ungroupFolder = useCallback(
    (id: string) =>
      changeStructure("ungroup folder", (s) => {
        const f = s.folders.find((x) => x.id === id);
        const inner = s.canvases[id];
        if (!f || !inner) return null;
        const pk = keyOf(f.parent);
        const outer = s.canvases[pk];
        const at = outer.folders[id] ?? freeSpot(outer);
        const all: Items = { cards: Object.keys(inner.cards), frames: Object.keys(inner.frames), folders: Object.keys(inner.folders) };
        const [, merged] = transfer(inner, outer, all, { x: at.x, y: at.y });
        const folders = { ...merged.folders };
        delete folders[id];
        const canvases = { ...s.canvases, [pk]: { ...merged, folders } };
        delete canvases[id];
        return { canvases, folders: s.folders.filter((x) => x.id !== id).map((x) => (x.parent === id ? { ...x, parent: f.parent } : x)) };
      }),
    [changeStructure],
  );

  /** Frame -> folder: same title, colour and place; its members move inside keeping their layout. */
  const frameToFolder = useCallback(
    (frameId: string, members: Items) => {
      const d = dataRef.current;
      const fr = d?.canvas.frames[frameId];
      if (!d || !fr) return null;
      const id = newFolderId();
      const key = keyOf(folderRef.current);
      const ok = changeStructure("turn frame into folder", (s) => {
        const cur = s.canvases[key];
        const frames = { ...cur.frames };
        delete frames[frameId];
        const pts = [...(members.cards ?? []).map((m) => cur.cards[m]), ...(members.folders ?? []).map((m) => cur.folders[m]), ...(members.frames ?? []).map((m) => cur.frames[m])].filter(Boolean);
        const minX = pts.length ? Math.min(...pts.map((p) => p.x)) : fr.x;
        const minY = pts.length ? Math.min(...pts.map((p) => p.y)) : fr.y;
        // Keep the members where they sat relative to the frame's corner.
        let [outer, inner] = transfer({ ...cur, frames }, blankCanvas(), members, { x: Math.round(minX - fr.x), y: Math.round(minY - fr.y) });
        const t = stamp();
        const rec: Folder = { id, title: fr.title, parent: folderRef.current, created: t, updated: t, ...(fr.color ? { color: fr.color } : {}) };
        outer = { ...outer, folders: { ...outer.folders, [id]: { x: fr.x, y: fr.y, z: maxZ(outer) + 1 } } };
        const folders = s.folders.map((f) => (members.folders?.includes(f.id) ? { ...f, parent: id } : f));
        return { canvases: { ...s.canvases, [key]: outer, [id]: inner }, folders: [...folders, rec] };
      });
      return ok ? id : null;
    },
    [changeStructure],
  );

  /** Folder -> frame: contents move up into a frame of the same title where the folder was; nested folders stay folders. */
  const folderToFrame = useCallback(
    (id: string) => {
      const frameId = newFrameId();
      const ok = changeStructure("lay out as frame", (s) => {
        const f = s.folders.find((x) => x.id === id);
        const inner = s.canvases[id];
        if (!f || !inner) return null;
        const pk = keyOf(f.parent);
        const outer = s.canvases[pk];
        const at = outer.folders[id] ?? freeSpot(outer);
        const PAD = 40;
        const b = boundsOf(inner);
        const all: Items = { cards: Object.keys(inner.cards), frames: Object.keys(inner.frames), folders: Object.keys(inner.folders) };
        const [, merged] = transfer(inner, outer, all, { x: at.x + PAD, y: at.y + PAD });
        const folders = { ...merged.folders };
        delete folders[id];
        const zs = all.frames!.map((k) => merged.frames[k]?.z).filter((z): z is number => z !== undefined);
        const topZ = Math.max(0, ...Object.values(outer.frames).map((x) => x.z));
        // Behind what it holds: below the lowest frame that came up with it.
        const frame: Frame = { x: at.x, y: at.y, w: Math.max(240, Math.round((b?.w ?? 400) + PAD * 2)), h: Math.max(160, Math.round((b?.h ?? 240) + PAD * 2)), title: f.title || "Untitled frame", z: zs.length ? Math.min(...zs) - 1 : topZ + 1, ...(f.color ? { color: f.color } : {}) };
        const canvases = { ...s.canvases, [pk]: { ...merged, folders, frames: { ...merged.frames, [frameId]: frame } } };
        delete canvases[id];
        return { canvases, folders: s.folders.filter((x) => x.id !== id).map((x) => (x.parent === id ? { ...x, parent: f.parent } : x)) };
      });
      return ok ? frameId : null;
    },
    [changeStructure],
  );

  /** A folder and everything below it go to Trash as one item (Undo restores it in place). */
  const deleteFolder = useCallback(
    async (id: string) => {
      const slug = activeRef.current;
      const d = dataRef.current;
      const f = d?.folders.find((x) => x.id === id);
      if (!slug || !d || !f) return;
      if (folderRef.current && isInside(d.folders, folderRef.current, id)) openFolder(f.parent);
      await flushCanvas();
      const item = await run(() => api.deleteFolder(slug, id));
      if (!item) return;
      pushUndo({
        label: "delete folder",
        folder: f.parent,
        undo: async () => void (await api.restoreCard(slug, id)),
        redo: async () => {
          await flushCanvas();
          await api.deleteFolder(slug, id);
        },
      });
      const n = item.count ?? 0;
      setNotice(`Folder${n ? ` and ${n} card${n === 1 ? "" : "s"}` : ""} moved to Trash.`);
      setNoticeUndo(true);
    },
    [openFolder, flushCanvas, run, pushUndo, setNotice],
  );

  /** "New version from <from>": one copy in Rust, then it opens. Undo = the new version to Trash. */
  const newVersion = useCallback(
    async (from: string, title: string): Promise<string | null> => {
      const slug = activeRef.current;
      if (!slug) return null;
      await flushCanvas();
      try {
        const out = await api.newVersion(slug, from, title);
        const id = out.version.id;
        await refresh();
        openFolder(id);
        pushUndo({
          label: "new version",
          folder: id,
          undo: async () => {
            if (folderRef.current && isInside(dataRef.current?.folders ?? [], folderRef.current, id)) openFolder(from);
            await api.deleteFolder(slug, id);
          },
          redo: async () => void (await api.restoreCard(slug, id)),
        });
        setNotice(`${title} created from ${folderName(dataRef.current?.folders.find((f) => f.id === from))} (${Object.keys(out.cards).length} cards).`);
        return null;
      } catch (e) {
        return message(e);
      }
    },
    [flushCanvas, refresh, openFolder, pushUndo, setNotice],
  );

  /** The one-time "Treat these folders as versions?" answer; then the project opens on its last version. */
  const migrateVersions = useCallback(
    async (ids: string[]) => {
      const slug = activeRef.current;
      if (!slug) return;
      await flushCanvas();
      await run(() => api.migrateVersions(slug, ids));
      const d = dataRef.current;
      if (d) openFolder(startFolder(d));
    },
    [flushCanvas, run, openFolder],
  );

  /** The canvas a card is on (ROOT = the root), or undefined. */
  const folderOfCard = useCallback((id: string): string | undefined => {
    const d = dataRef.current;
    return d ? Object.entries(d.canvases).find(([, c]) => c.cards[id])?.[0] : undefined;
  }, []);

  const createFrame = useCallback(
    (rect: { x: number; y: number; w: number; h: number }, title = "Untitled frame", color?: string): string | null => {
      const d = dataRef.current;
      if (!d) return null;
      const before = layoutOf(d.canvas);
      const id = newFrameId();
      const zs = Object.values(before.frames).map((f) => f.z);
      const frame: Frame = { ...rect, title, z: zs.length ? Math.max(...zs) + 1 : 0, ...(color ? { color } : {}) };
      patchCanvas((c) => ({ ...c, frames: { ...(c.frames ?? {}), [id]: frame } }));
      commitLayout("add frame", before);
      return id;
    },
    [patchCanvas, commitLayout],
  );

  /** Moves cards (align, distribute) as one undo step. */
  const arrangeCards = useCallback(
    (label: string, moves: Record<string, { x: number; y: number }>) => {
      const before = layoutSnapshot();
      if (!before) return;
      patchCanvas((c) => {
        const cards = { ...c.cards };
        for (const [id, p] of Object.entries(moves)) if (cards[id]) cards[id] = { ...cards[id], x: Math.round(p.x), y: Math.round(p.y) };
        return { ...c, cards };
      });
      commitLayout(label, before);
    },
    [layoutSnapshot, patchCanvas, commitLayout],
  );

  const updateFrame = useCallback(
    (id: string, patch: Partial<Frame>, label = "edit frame") => {
      const before = layoutSnapshot();
      if (!before?.frames[id]) return;
      patchCanvas((c) => ({ ...c, frames: { ...c.frames, [id]: { ...c.frames[id], ...patch } } }));
      commitLayout(label, before);
    },
    [layoutSnapshot, patchCanvas, commitLayout],
  );

  /** Deletes the frame only; its cards stay where they are. */
  const deleteFrame = useCallback(
    (id: string) => {
      const before = layoutSnapshot();
      if (!before?.frames[id]) return;
      patchCanvas((c) => {
        const frames = { ...c.frames };
        delete frames[id];
        return { ...c, frames };
      });
      commitLayout("delete frame", before);
      setNotice("Frame deleted; its cards stay.");
      setNoticeUndo(true);
    },
    [layoutSnapshot, patchCanvas, commitLayout, setNotice],
  );

  /** Deletes a frame and moves its cards to Trash, as one undo step. */
  const deleteFrameAndCards = useCallback(
    async (frameId: string, cardIds: string[]) => {
      const slug = activeRef.current;
      const before = layoutSnapshot();
      if (!slug || !before?.frames[frameId]) return;
      const dropFrame = async () => {
        patchCanvas((c) => {
          const frames = { ...c.frames };
          delete frames[frameId];
          return { ...c, frames };
        });
        await flushCanvas();
      };
      const redo = async () => {
        // Frame first: a canvas save after the cards are trashed would write their old positions back.
        await dropFrame();
        for (const id of cardIds) await api.deleteCard(slug, id);
      };
      const undo = async () => {
        for (const id of [...cardIds].reverse()) await api.restoreCard(slug, id);
        await refresh();
        patchCanvas((c) => ({ ...c, ...before }));
        await flushCanvas();
      };
      try {
        await redo();
      } catch (e) {
        setError(message(e));
      }
      pushUndo({ label: "delete frame and cards", undo, redo });
      setNotice(cardIds.length ? `Frame and ${cardIds.length} card${cardIds.length === 1 ? "" : "s"} moved to Trash.` : "Frame deleted.");
      setNoticeUndo(true);
      await refresh();
    },
    [layoutSnapshot, patchCanvas, flushCanvas, pushUndo, refresh, setNotice],
  );

  const sendToBack = useCallback((id: string) => setStacking(id, "back"), [setStacking]);

  // ----- cards -----

  const createCard = useCallback(
    async (card: NewCard) => {
      const slug = activeRef.current!;
      // New cards land on the open canvas.
      const into = folderRef.current;
      const created = await run(() => api.createCard(slug, { ...(into ? { folder: into } : {}), ...card }));
      if (created) {
        pushUndo({
          label: "create card",
          undo: async () => api.deleteCard(slug, created.id).then(() => {}),
          redo: async () => api.restoreCard(slug, created.id).then(() => {}),
        });
      }
      return created;
    },
    [run, pushUndo],
  );

  /** "Mark as built now" / "Clear needs rebuild": one undo step puts the build block, snapshot and stage back. */
  const markBuiltNow = useCallback(
    async (id: string) => {
      const slug = activeRef.current!;
      const before = dataRef.current?.cards.find((c) => c.id === id);
      if (!before) return;
      const prevBuild = before.build ?? null;
      const prevStage = before.stage;
      const prevSnapshot = (await api.buildTexts(slug, id).catch(() => null))?.snapshot ?? null;
      const updated = await run(() => api.markBuiltNow(slug, id));
      if (updated) {
        pushUndo({
          label: "mark as built",
          undo: async () => void (await api.restoreBuild(slug, id, prevBuild, prevSnapshot, prevStage)),
          redo: async () => void (await api.markBuiltNow(slug, id)),
        });
      }
      return updated;
    },
    [run, pushUndo],
  );

  /** Build board moves: the card's build block becomes `next` (snapshot and stage kept); one undo step. */
  const setBuildBlock = useCallback(
    async (id: string, next: BuildBlock | null, label: string) => {
      const slug = activeRef.current!;
      const before = dataRef.current?.cards.find((c) => c.id === id);
      if (!before) return;
      const prev = before.build ?? null;
      const snapshot = (await api.buildTexts(slug, id).catch(() => null))?.snapshot ?? null;
      const updated = await run(() => api.restoreBuild(slug, id, next, snapshot, before.stage));
      if (updated) {
        pushUndo({
          label,
          undo: async () => void (await api.restoreBuild(slug, id, prev, snapshot, before.stage)),
          redo: async () => void (await api.restoreBuild(slug, id, next, snapshot, before.stage)),
        });
      }
      return updated;
    },
    [run, pushUndo],
  );

  const updateCard = useCallback(
    async (id: string, patch: CardPatch) => {
      const slug = activeRef.current!;
      const before = dataRef.current?.cards.find((c) => c.id === id);
      const prevPatch: CardPatch = before ? prevOf(before, patch) : {};
      // Editing a Claude suggestion keeps it: Keep (ghost off, a merge's originals to Trash) then
      // the edit, as one undo step. Moves and resizes never come through here.
      if (before?.ghost && !("ghost" in patch)) {
        const originals = liveOriginals(before);
        const reason = `merged into ${patch.title ?? before.title}`;
        const apply = async () => {
          const u = await api.updateCard(slug, id, { ghost: false });
          for (const o of originals) await api.loseCard(slug, o, reason);
          return Object.keys(patch).length ? api.updateCard(slug, id, patch) : u;
        };
        const revert = async () => {
          for (const o of originals) await api.restoreCard(slug, o);
          await api.updateCard(slug, id, { ...prevPatch, ghost: true });
        };
        const updated = await run(apply);
        if (updated) pushUndo({ label: "keep suggestion", undo: revert, redo: async () => void (await apply()) });
        return updated;
      }
      const updated = await run(() => api.updateCard(slug, id, patch));
      if (updated && before) {
        pushUndo({
          label: "update card",
          undo: async () => api.updateCard(slug, id, prevPatch).then(() => {}),
          redo: async () => api.updateCard(slug, id, patch).then(() => {}),
        });
      }
      return updated;
    },
    [run, pushUndo],
  );

  /** Patches several cards as one undo step (stage, tags, link reversal). */
  const updateMany = useCallback(
    async (label: string, edits: { id: string; patch: CardPatch }[]) => {
      const slug = activeRef.current;
      const cards = dataRef.current?.cards ?? [];
      if (!slug || !edits.length) return;
      const undoEdits = edits.flatMap(({ id, patch }) => {
        const before = cards.find((c) => c.id === id);
        return before ? [{ id, patch: prevOf(before, patch) }] : [];
      });
      // Editing a suggestion keeps it (same undo step); a merge's originals go to Trash with it.
      const ghosts = edits.flatMap(({ id }) => {
        const c = cards.find((x) => x.id === id);
        return c?.ghost ? [{ id: c.id, title: c.title, originals: liveOriginals(c) }] : [];
      });
      const apply = (list: { id: string; patch: CardPatch }[], keep: boolean) => async () => {
        if (keep) {
          for (const g of ghosts) {
            await api.updateCard(slug, g.id, { ghost: false });
            for (const o of g.originals) await api.loseCard(slug, o, `merged into ${g.title}`);
          }
        }
        for (const { id, patch } of list) await api.updateCard(slug, id, patch);
        if (!keep) {
          for (const g of ghosts) {
            for (const o of g.originals) await api.restoreCard(slug, o);
            await api.updateCard(slug, g.id, { ghost: true });
          }
        }
      };
      const ok = await run(async () => {
        await apply(edits, true)();
        return true;
      });
      if (ok) pushUndo({ label, undo: apply([...undoEdits].reverse(), false), redo: apply(edits, true) });
    },
    [run, pushUndo],
  );

  /**
   * Appends `text` to the project's Tech & constraints / Project decisions card, creating it when
   * missing, together with `edits` to other cards: one undo step.
   */
  const appendToRoleCard = useCallback(
    async (role: "tech" | "decisions", text: string, label: string, edits: { id: string; patch: CardPatch }[] = []) => {
      const slug = activeRef.current;
      if (!slug) return;
      const join = (body: string) => `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${text}`;
      const card = dataRef.current?.cards.find((c) => c.role === role && !c.ghost);
      if (card) return updateMany(label, [{ id: card.id, patch: { body: join(card.body) } }, ...edits]);
      const fresh: NewCard =
        role === "tech"
          ? { title: TECH_TITLE, role: "tech", body: TECH_TEMPLATE }
          : { title: DECISIONS_TITLE, role: "decisions", stage: "lucid", body: "Answers that settle open project questions." };
      const into = folderRef.current;
      const created = await run(() => api.createCard(slug, { ...(into ? { folder: into } : {}), ...fresh, body: join(fresh.body ?? "") }));
      if (!created) return;
      const cards = dataRef.current?.cards ?? [];
      const undoEdits = edits.flatMap(({ id, patch }) => {
        const before = cards.find((c) => c.id === id);
        return before ? [{ id, patch: prevOf(before, patch) }] : [];
      });
      const apply = async (list: { id: string; patch: CardPatch }[]) => {
        for (const { id, patch } of list) await api.updateCard(slug, id, patch);
      };
      await run(async () => (await apply(edits), true));
      pushUndo({
        label,
        undo: async () => {
          await apply([...undoEdits].reverse());
          await api.deleteCard(slug, created.id);
        },
        redo: async () => {
          await api.restoreCard(slug, created.id);
          await apply(edits);
        },
      });
    },
    [run, pushUndo, updateMany],
  );

  /**
   * Deletes checklist items. Answered questions go to Project decisions first (same undo step);
   * a deleted cc-questions item's QUESTIONS.md line is remembered so it is never re-imported.
   */
  const deleteChecklistItems = useCallback(
    async (cardId: string, ids: string[]) => {
      const card = dataRef.current?.cards.find((c) => c.id === cardId);
      if (!card) return;
      const drop = new Set(ids);
      const gone = (card.items ?? []).filter((i) => drop.has(i.id));
      if (!gone.length) return;
      const patch: CardPatch = { items: (card.items ?? []).filter((i) => !drop.has(i.id)) };
      const sources = gone.flatMap((i) => (i.source ? [i.source] : []));
      if (sources.length) patch.dismissed_sources = [...(card.dismissed_sources ?? []), ...sources];
      const answered = gone.filter((i) => i.question && i.answer?.trim());
      if (!answered.length) return void (await updateCard(cardId, patch));
      const text = answered.map((i) => `**Q:** ${parseItem(i.text).body}\n**A:** ${i.answer!.trim()}`).join("\n\n");
      await appendToRoleCard("decisions", text, answered.length > 1 ? "clear answered" : "delete item", [{ id: cardId, patch }]);
    },
    [updateCard, appendToRoleCard],
  );

  /** "Convert to": only the kind changes, so title, body, attachments (and items) carry over. */
  const convertKind = useCallback(
    async (id: string, kind: CardKind) => {
      const card = dataRef.current?.cards.find((c) => c.id === id);
      if (card && card.kind !== kind) await updateCard(id, { kind });
    },
    [updateCard],
  );

  const deleteCard = useCallback(
    async (id: string) => {
      const slug = activeRef.current!;
      const item = await run(() => api.deleteCard(slug, id));
      if (item) {
        pushUndo({
          label: "delete card",
          undo: async () => api.restoreCard(slug, id).then(() => {}),
          redo: async () => api.deleteCard(slug, id).then(() => {}),
        });
      }
      return item;
    },
    [run, pushUndo],
  );

  /** Move several cards to Trash ("deleted") as one undo step, with an Undo toast. No confirm. */
  const deleteCards = useCallback(
    async (ids: string[]) => {
      const slug = activeRef.current;
      if (!slug || ids.length === 0) return;
      const done: string[] = [];
      try {
        for (const id of ids) {
          await api.deleteCard(slug, id);
          done.push(id);
        }
      } catch (e) {
        setError(message(e));
      }
      if (done.length) {
        pushUndo({
          label: done.length === 1 ? "delete card" : `delete ${done.length} cards`,
          undo: async () => { for (const id of done) await api.restoreCard(slug, id); },
          redo: async () => { for (const id of done) await api.deleteCard(slug, id); },
        });
        setNotice(done.length === 1 ? "Card moved to Trash." : `${done.length} cards moved to Trash.`);
        setNoticeUndo(true);
      }
      await refresh();
    },
    [pushUndo, refresh],
  );

  const loseCard = useCallback(
    async (id: string, reason: string) => {
      const slug = activeRef.current!;
      const item = await run(() => api.loseCard(slug, id, reason));
      if (item) {
        pushUndo({
          label: "lose fork",
          undo: async () => api.restoreCard(slug, id).then(() => {}),
          redo: async () => api.loseCard(slug, id, reason).then(() => {}),
        });
      }
      return item;
    },
    [run, pushUndo],
  );

  const addLink = useCallback(
    (fromId: string, toId: string, label?: string) => {
      const from = dataRef.current?.cards.find((c) => c.id === fromId);
      if (!from || fromId === toId || from.links.some((l) => l.to === toId)) return;
      const links: Link[] = [...from.links, { to: toId, label }];
      void updateCard(fromId, { links });
    },
    [updateCard],
  );

  const removeLink = useCallback(
    (fromId: string, toId: string) => {
      const from = dataRef.current?.cards.find((c) => c.id === fromId);
      if (!from) return;
      void updateCard(fromId, { links: from.links.filter((l) => l.to !== toId) });
    },
    [updateCard],
  );

  const setLinkLabel = useCallback(
    (fromId: string, toId: string, label: string) => {
      const from = dataRef.current?.cards.find((c) => c.id === fromId);
      if (!from) return;
      void updateCard(fromId, { links: from.links.map((l) => (l.to === toId ? { ...l, label: label || undefined } : l)) });
    },
    [updateCard],
  );

  // ----- attachments: every change is one updateCard of the whole list, so Undo/Redo restore it -----

  const attachmentsOf = (id: string): Attachment[] => dataRef.current?.cards.find((c) => c.id === id)?.attachments ?? [];

  /** Replace a card's attachment list (reorder, remove, caption, cover) as one undo step. */
  const setAttachments = useCallback((id: string, list: Attachment[]) => updateCard(id, { attachments: list }), [updateCard]);

  /** Saves files under media/ and returns them as image attachments (not yet on any card). */
  const saveImages = useCallback(async (files: (File | Blob)[]): Promise<Attachment[]> => {
    const slug = activeRef.current!;
    const uploads = await Promise.all(
      files.map(async (f, i) => ({ name_hint: (f as File).name || `pasted-${i}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    const rels = await api.saveMedia(slug, uploads);
    return rels.map((path) => ({ id: newAttId(), type: "image", path }));
  }, []);

  /** Save the files under media/ and append them as images (one undo step). */
  const addImages = useCallback(
    async (id: string, files: (File | Blob)[]) => {
      const slug = activeRef.current!;
      if (!files.length) return;
      try {
        const added = await saveImages(files);
        if (activeRef.current !== slug) return;
        await setAttachments(id, [...attachmentsOf(id), ...added]);
      } catch (e) {
        setError(message(e));
      }
    },
    [setAttachments, saveImages],
  );
  const addImage = useCallback((id: string, file: File | Blob, _nameHint?: string) => addImages(id, [file]), [addImages]);

  /** Fetch a page and append it as a clip. A failed fetch still adds a bare clip (with fetch_error). */
  const addClip = useCallback(
    async (id: string, url: string) => {
      const slug = activeRef.current!;
      try {
        const clip = await api.fetchClip(slug, url);
        if (activeRef.current !== slug) return null;
        await setAttachments(id, [...attachmentsOf(id), clip]);
        return clip;
      } catch (e) {
        setError(message(e));
        return null;
      }
    },
    [setAttachments],
  );

  /** Re-fetches a clip's page; Undo restores the previous preview. */
  const refreshClip = useCallback(
    async (id: string, attId: string) => {
      const slug = activeRef.current!;
      const before = attachmentsOf(id);
      const card = await run(() => api.refreshClip(slug, id, attId));
      if (card) {
        const after = card.attachments;
        pushUndo({
          label: "refresh preview",
          undo: async () => api.updateCard(slug, id, { attachments: before }).then(() => {}),
          redo: async () => api.updateCard(slug, id, { attachments: after }).then(() => {}),
        });
      }
      return card;
    },
    [run, pushUndo],
  );

  /**
   * Keep on a ghost card. A merge ghost (`merged_from`) also moves its originals to Trash, all as
   * one undo step. Dismiss needs nothing special: the originals were never touched.
   */
  const requestChat = useCallback((r: Omit<ChatRequest, "n">) => setChatRequest({ ...r, n: ++chatSeq.current }), []);

  /** "Answer with Claude": a quiet /grill-me checklist turn in the card's thread over its open questions. */
  const startChecklistGrill = useCallback(
    (cardId: string) => {
      const card = dataRef.current?.cards.find((c) => c.id === cardId);
      const gone = new Set(card?.dismissed_sources ?? []);
      const open = (card?.items ?? []).filter((i) => i.question && !i.answer?.trim() && !(i.source && gone.has(i.source)));
      if (!card || !open.length) return;
      const lines = open.map((i) => {
        const p = parseItem(i.text);
        return `[${i.id}] ${p.body}${p.context ? ` — ${p.context}` : ""}`;
      });
      setContextCardId(cardId);
      requestChat({ thread: cardId, send: true, quiet: true, text: `/grill-me checklist\n${lines.join("\n")}`, display: `/grill-me checklist (${open.length} open)` });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestChat],
  );

  // ----- artifacts -----

  /** Runs an artifact turn on Claude in the artifact's own thread (its chat opens there). */
  const runArtifact = useCallback(
    (id: string, text: string, display: string, o?: { recapFrom?: string }) => {
      setContextCardId(id);
      requestChat({ text, display, thread: id, send: true, artifact: id, wait: true, recapFrom: o?.recapFrom });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestChat],
  );

  /**
   * Creates an artifact card (undoable like any card) and, unless `generate` is false (a ghost),
   * starts its first Claude turn.
   */
  const createArtifact = useCallback(
    async (a: NewArtifact, o?: { generate?: boolean; recapFrom?: string }) => {
      const slug = activeRef.current!;
      const into = folderRef.current;
      const created = await run(() => api.artifactCreate(slug, { ...(into ? { folder: into } : {}), ...a }));
      if (!created) return null;
      pushUndo({
        label: "create artifact",
        undo: async () => api.deleteCard(slug, created.id).then(() => {}),
        redo: async () => api.restoreCard(slug, created.id).then(() => {}),
      });
      await refresh();
      if (o?.generate !== false && !a.ghost) runArtifact(created.id, createPrompt(a.type, created.title), `Make the ${ARTIFACT_LABEL[a.type].toLowerCase()}`, { recapFrom: o?.recapFrom });
      return created;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, pushUndo, runArtifact],
  );

  const keepGhostCard = useCallback(
    async (id: string) => {
      const slug = activeRef.current!;
      const card = dataRef.current?.cards.find((c) => c.id === id);
      const originals = (card?.merged_from ?? []).filter((o) => dataRef.current?.cards.some((c) => c.id === o));
      if (!card || originals.length === 0) {
        await updateCard(id, { ghost: false });
        // A ghost artifact (Claude's proposal) is generated once the user keeps it.
        if (card?.kind === "artifact") runArtifact(id, createPrompt(artifactType(card), card.title), `Make the ${ARTIFACT_LABEL[artifactType(card)].toLowerCase()}`);
        return;
      }
      const reason = `merged into ${card.title}`;
      const apply = async () => {
        await api.updateCard(slug, id, { ghost: false });
        for (const o of originals) await api.loseCard(slug, o, reason);
      };
      const revert = async () => {
        for (const o of originals) await api.restoreCard(slug, o);
        await api.updateCard(slug, id, { ghost: true });
      };
      const ok = await run(async () => {
        await apply();
        return true;
      });
      if (ok) pushUndo({ label: "keep merge", undo: revert, redo: apply });
    },
    [run, pushUndo, updateCard, runArtifact],
  );

  /**
   * Keep all / Dismiss all for the project's Claude suggestions (ghost cards + edit proposals),
   * each as one undo step. Keep applies every proposal; Dismiss trashes the ghosts and drops the
   * proposal files (Undo writes them back).
   */
  const settleSuggestions = useCallback(
    async (keep: boolean) => {
      const slug = activeRef.current;
      const d = dataRef.current;
      if (!slug || !d) return;
      const ghosts = d.cards.filter((c) => c.ghost).map((c) => ({ id: c.id, title: c.title, originals: liveOriginals(c) }));
      const props = Object.entries(d.proposals ?? {}).flatMap(([id, p]) => {
        const c = d.cards.find((x) => x.id === id);
        if (!c) return [];
        const patch = keep ? proposalPatch(c, p) : {};
        const prev: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) prev[k] = (c as unknown as Record<string, unknown>)[k];
        return [{ id, p: p as EditProposal, patch, prev: prev as CardPatch, ghost: !!c.ghost }];
      });
      if (!ghosts.length && !props.length) return;
      const apply = async () => {
        for (const g of ghosts) {
          if (keep) {
            await api.updateCard(slug, g.id, { ghost: false });
            for (const o of g.originals) await api.loseCard(slug, o, `merged into ${g.title}`);
          } else await api.deleteCard(slug, g.id);
        }
        for (const x of props) {
          if (keep && Object.keys(x.patch).length) await api.updateCard(slug, x.id, x.patch);
          await api.dismissProposal(slug, x.id);
        }
      };
      const revert = async () => {
        for (const x of [...props].reverse()) {
          if (keep && Object.keys(x.prev).length) await api.updateCard(slug, x.id, x.prev);
          await api.restoreProposal(slug, x.id, x.p);
        }
        for (const g of [...ghosts].reverse()) {
          if (keep) {
            for (const o of g.originals) await api.restoreCard(slug, o);
            await api.updateCard(slug, g.id, { ghost: true });
          } else await api.restoreCard(slug, g.id);
        }
      };
      const ok = await run(async () => {
        await apply();
        return true;
      });
      if (ok) pushUndo({ label: keep ? "keep all suggestions" : "dismiss all suggestions", undo: revert, redo: apply });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, pushUndo],
  );
  const keepAllSuggestions = useCallback(() => settleSuggestions(true), [settleSuggestions]);
  const dismissAllSuggestions = useCallback(() => settleSuggestions(false), [settleSuggestions]);

  // (requestChat is defined with the artifact actions, above keepGhostCard)

  // ----- ghost links (Claude's /related proposals) -----

  const addGhostLink = useCallback((g: Omit<GhostLink, "key">) => {
    const key = `${g.slug}:${g.from}->${g.to}`;
    setGhostLinks((prev) => (prev.some((x) => x.key === key) ? prev : [...prev, { ...g, key }]));
  }, []);

  const dropGhostLink = useCallback((key: string) => setGhostLinks((prev) => prev.filter((x) => x.key !== key)), []);

  const keepGhostLink = useCallback(
    async (g: GhostLink) => {
      const from = dataRef.current?.cards.find((c) => c.id === g.from);
      if (!from) return;
      dropGhostLink(g.key);
      if (from.links.some((l) => l.to === g.to)) return;
      const before = from.links;
      const after: Link[] = [...before, { to: g.to, label: g.label }];
      const ok = await run(() => api.updateCard(g.slug, g.from, { links: after }));
      if (!ok) {
        addGhostLink(g);
        return;
      }
      pushUndo({
        label: "keep link",
        undo: async () => {
          await api.updateCard(g.slug, g.from, { links: before });
          addGhostLink(g);
        },
        redo: async () => {
          await api.updateCard(g.slug, g.from, { links: after });
          dropGhostLink(g.key);
        },
      });
    },
    [run, pushUndo, addGhostLink, dropGhostLink],
  );

  const dismissGhostLink = useCallback(
    (g: GhostLink) => {
      dropGhostLink(g.key);
      pushUndo({
        label: "dismiss link",
        undo: async () => addGhostLink(g),
        redo: async () => dropGhostLink(g.key),
      });
    },
    [pushUndo, addGhostLink, dropGhostLink],
  );

  // ----- focus a card (search results) -----

  const focusCard = useCallback(
    async (id: string, slug?: string) => {
      const target = slug ?? activeRef.current;
      if (!target) return;
      if (target !== activeRef.current) await select(target);
      // Inside another folder: open it first.
      const where = folderOfCard(id);
      if (where !== undefined) openFolder(where || null);
      setContextCardId(id);
      setFocusRequest({ id, slug: target, n: ++focusSeq.current });
    },
    [select, folderOfCard, openFolder],
  );

  return {
    ready,
    projects,
    active,
    data,
    error,
    clearError: () => setError(null),
    select,
    /** Creates and selects a project. Returns the error text instead of toasting it, so the name
     *  field can show it inline and keep what the user typed. */
    createProject: async (name: string): Promise<string | null> => {
      try {
        const p = await api.createProject(name);
        await select(p.slug);
        return null;
      } catch (e) {
        await refresh();
        return message(e);
      }
    },
    notice,
    noticeUndo,
    clearNotice: () => setNotice(null),
    toast: setNotice,
    keepGhostCard,
    keepAllSuggestions,
    dismissAllSuggestions,
    chatRequest,
    requestChat,
    startChecklistGrill,
    createArtifact,
    runArtifact,
    clearChatRequest: () => setChatRequest(null),
    handoffRequest,
    openHandoff: (scope: HandoffScope) => setHandoffRequest({ scope, n: ++handoffSeq.current }),
    clearHandoff: () => setHandoffRequest(null),
    taskRequest,
    openTask: (scope: HandoffScope) => setTaskRequest({ scope, n: ++handoffSeq.current }),
    clearTask: () => setTaskRequest(null),
    designOpen,
    setDesignOpen,
    memoryOpen,
    setMemoryOpen,
    /**
     * Sidebar "Delete project" (after the user confirmed). Moves the selection to the Inbox first,
     * so neither the reload nor the file watcher ever looks for the vanished folder.
     */
    deleteProject: async (slug: string) => {
      if (slug === INBOX) return;
      if (activeRef.current === slug) await select(INBOX);
      try {
        const out = await api.deleteProject(slug);
        setNotice(out.recycled ? "Project moved to the Recycle Bin." : "Project deleted from disk.");
      } catch (e) {
        setError(message(e));
      }
      await refresh();
    },
    setProjectTheme: (themeId: string | null) => run(() => api.updateProject(activeRef.current!, { theme: themeId ?? "" })),
    createCard,
    updateCard,
    markBuiltNow,
    setBuildBlock,
    deleteCard,
    deleteCards,
    loseCard,
    refresh,
    addLink,
    removeLink,
    setLinkLabel,
    addImage,
    addImages,
    addClip,
    refreshClip,
    setAttachments,
    moveCard,
    resizeCard,
    bringToFront,
    sendToBack,
    layoutSnapshot,
    patchFrameLive,
    commitLayout,
    createFrame,
    updateFrame,
    deleteFrame,
    deleteFrameAndCards,
    arrangeCards,
    updateMany,
    appendToRoleCard,
    deleteChecklistItems,
    saveImages,
    convertKind,
    setViewport,
    flushCanvas,
    folder,
    openFolder,
    folderOfCard,
    structure,
    organizePreview,
    setOrganizePreview,
    applyOrganize,
    setNudgeOff,
    createFolder,
    moveItems,
    reparentFolder,
    updateFolder,
    ungroupFolder,
    frameToFolder,
    folderToFrame,
    deleteFolder,
    newVersion,
    migrateVersions,
    versionDialog,
    setVersionDialog,
    patchFolderLive,
    setPinned,
    setFolderStacking: (id: string, where: "front" | "back") => setStacking(id, where, "folders"),
    linkMode,
    linkFrom,
    setLinking,
    canUndo,
    canRedo,
    undo,
    redo,
    contextCardId,
    setContextCard: setContextCardId,
    setCanvasSelection,
    getCanvasSelection,
    ghostLinks: ghostLinks.filter((g) => g.slug === active),
    addGhostLink,
    keepGhostLink,
    dismissGhostLink,
    focusRequest,
    focusCard,
    clearFocus: () => setFocusRequest(null),
    setError,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
