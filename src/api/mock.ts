import { DESIGN_DOCS, GAP_CHECKLIST, type Api, type Attachment, type Canvas, type Card, type CardRole, type ChangeEvent, type ChatThreadFile, type ChecklistItem, type DesignVersion, type Folder, type HandoffEvent, type HandoffEventBody, type MemoryEvent, type MemoryLogEntry, type MemoryView, type NewCard, type ProjectData, type ProjectSummary, type SearchHit, type Settings, type TrashItem } from "./types";

/** Same rules as the Rust core: media paths stay under media/, clips need a url. */
function checkAttachment(a: Attachment) {
  const paths = a.type === "image" ? [a.path] : [a.favicon, a.thumb, a.excerpt].filter((p): p is string => !!p);
  for (const p of paths) {
    // mock: paths come from the mock saveMedia (blob URLs) and are allowed too.
    if (p.startsWith("mock:")) continue;
    if (!p.startsWith("media/") || p.includes("\\") || p.split("/").some((s) => s === ".." || s === "")) throw new Error(`attachment path must be under media/: "${p}"`);
  }
  if (a.type === "clip" && !a.url.trim()) throw new Error("a clip needs a url");
}
const attKey = (a: Attachment) => `${a.type}:${a.type === "image" ? a.path : a.url}`;
/** Concatenate, dedupe by path/url, give missing or duplicate ids a fresh one. */
function mergeAttachments(...lists: Attachment[][]): Attachment[] {
  const out: Attachment[] = [];
  for (const a of lists.flat()) {
    if (out.some((o) => attKey(o) === attKey(a))) continue;
    const id = !a.id || out.some((o) => o.id === a.id) ? nid() : a.id;
    out.push({ ...a, id });
  }
  return out;
}
function checkAttachments(list: Attachment[]): Attachment[] {
  list.forEach(checkAttachment);
  return mergeAttachments(list);
}
function checkItems(items: ChecklistItem[]): ChecklistItem[] {
  const seen = new Set<string>();
  return items.map((it) => {
    const id = !it.id?.trim() || seen.has(it.id) ? nid() : it.id;
    seen.add(id);
    return { ...it, id };
  });
}
const cleanColor = (c: string | undefined) => c?.trim() || undefined;

/** A rough browser-only stand-in for the Rust scorer (title > tags > fields > body). */
const foldText = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function mockScore(c: Card, words: string[]): number {
  const title = foldText(c.title);
  const tags = foldText(c.tags.join(" "));
  // Mirrors search.rs: checklist items/answers and attachment captions / clip titles count as fields.
  const extra = [
    ...(c.items ?? []).flatMap((i) => [i.text, i.answer ?? ""]),
    ...c.attachments.flatMap((a) => (a.type === "clip" ? [a.title ?? "", a.caption ?? "", a.site ?? ""] : [a.caption ?? ""])),
  ];
  const fields = foldText([...Object.values(c.fields).filter((v) => typeof v === "string"), ...extra].join(" "));
  const body = foldText(c.body);
  let total = 0;
  let matched = 0;
  for (const w of words) {
    const s = (title.includes(w) ? 10 : 0) + (tags.includes(w) ? 6 : 0) + (fields.includes(w) ? 4 : 0) + (body.includes(w) ? 1 : 0);
    if (s) matched++;
    total += s;
  }
  return matched ? total * (0.4 + 0.6 * (matched / words.length) ** 2) : 0;
}

/**
 * In-memory stand-in so `npm run dev` (plain browser) and screenshots work without the Rust core.
 * It mirrors the command signatures only loosely: the real behavior is tested in Rust.
 */
interface MockProject {
  slug: string;
  name: string;
  theme: string | null;
  handoffTarget?: string;
  handoffConfirmed?: string;
  design: { entry: DesignVersion; docs: Record<string, string> }[];
  canvas: Canvas;
  folders: Folder[];
  canvases: Record<string, Canvas>;
  /** Trashed folders: their subtree, canvases and card ids. */
  trashedFolders: Map<string, { folders: Folder[]; canvases: Record<string, Canvas>; cards: string[] }>;
  cards: Map<string, Card>;
  trash: TrashItem[];
  trashed: Map<string, Card>;
}

let seq = 0;
const nid = () => `01MOCK${String(++seq).padStart(20, "0")}`;
const stamp = () => new Date().toISOString();

function mkCard(c: NewCard): Card {
  const t = stamp();
  const card: Card = {
    id: nid(), title: c.title?.trim() || "Untitled", kind: c.kind ?? "card", stage: c.stage ?? "mist", tags: c.tags ?? [], fields: c.fields ?? {},
    created: t, updated: t, source: c.source ?? "user", ghost: c.ghost ?? false, links: c.links ?? [], body: c.body ?? "",
    attachments: checkAttachments(c.attachments ?? []),
  };
  if (c.role) card.role = c.role;
  const color = cleanColor(c.color);
  if (color) card.color = color;
  if (c.items?.length) card.items = checkItems(c.items);
  return card;
}

function seedProject(slug: string, name: string): MockProject {
  return { slug, name, theme: null, design: [], canvas: emptyCanvas(), folders: [], canvases: {}, trashedFolders: new Map(), cards: new Map(), trash: [], trashed: new Map() };
}

const emptyCanvas = (): Canvas => ({ version: 3, viewport: { x: 300, y: 110, zoom: 1 }, cards: {}, frames: {}, folders: {} });
const canvasOf = (p: MockProject, folder?: string | null) => (folder ? (p.canvases[folder] ??= emptyCanvas()) : p.canvas);
const locate = (p: MockProject, id: string): string | null => Object.entries(p.canvases).find(([, c]) => c.cards[id])?.[0] ?? null;
const subtreeOf = (p: MockProject, id: string) => {
  const out = [id];
  for (let i = 0; i < out.length; i++) out.push(...p.folders.filter((f) => f.parent === out[i]).map((f) => f.id));
  return out;
}

/** "tech" and "decisions"; only one live card per project may hold each. */
function checkRole(p: MockProject, role: string | undefined, except?: string): CardRole | undefined {
  const r = role?.trim().toLowerCase();
  if (!r) return undefined;
  if (r !== "tech" && r !== "decisions" && r !== "cc-questions") throw new Error(`unknown card role "${r}"`);
  const other = [...p.cards.values()].find((c) => c.role === r && c.id !== except);
  if (other) throw new Error(`this project already has a ${r === "tech" ? "Tech & constraints" : r === "decisions" ? "Project decisions" : "From Claude Code"} card (${other.id})`);
  return r;
}

const MEM_SECTIONS = ["Pitch", "Pillars", "Decisions", "Rejected", "Glossary", "How to work with me"];
function mockParse(text: string): [string, string[]][] {
  const out: [string, string[]][] = MEM_SECTIONS.map((s) => [s, []]);
  let cur = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const h = /^##+\s+(.*)$/.exec(t);
    if (h) {
      const i = MEM_SECTIONS.findIndex((s) => s.toLowerCase() === h[1].trim().toLowerCase());
      cur = i >= 0 ? i : cur;
    } else if (!t.startsWith("#")) out[cur][1].push(t.replace(/^[-*]\s*/, ""));
  }
  return out;
}
const mockRender = (s: [string, string[]][]) => s.map(([n, items]) => `## ${n}\n${items.map((i) => `- ${i}\n`).join("")}`).join("\n");

export function createMockApi(): Api {
  const settings: Settings = { version: 1, theme: "pearl-glow", hotkey: "Ctrl+Shift+Space", last_project: null, show_projects: true, show_chat: true, tray_notice_shown: false, start_with_windows: true, start_hidden: true, model_chat: "sonnet", model_router: true, model_fast: "haiku", model_deep: "opus", model_export: "opus", model_memory: "haiku", compact_tokens: 50000, memory_cap: 600, local_chat: true, local_model: "qwen3.5:35b-a3b" };
  const projects = new Map<string, MockProject>();
  const customThemes = new Map<string, unknown>();
  const chats = new Map<string, ChatThreadFile>();
  const listeners = new Set<(e: ChangeEvent[]) => void>();
  const handoffListeners = new Set<(e: HandoffEvent) => void>();
  const memoryListeners = new Set<(e: MemoryEvent) => void>();
  const memories = new Map<string, string>();
  const memLogs = new Map<string, MemoryLogEntry[]>();
  const memLog = (slug: string) => memLogs.get(slug) ?? memLogs.set(slug, []).get(slug)!;
  const memView = (slug: string): MemoryView => {
    const text = memories.get(slug) ?? mockRender(mockParse(""));
    return { exists: memories.has(slug), text, words: text.replace(/^## .*$/gm, "").split(/\s+/).filter(Boolean).length, cap: settings.memory_cap };
  };
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  let handoffCommit: (() => void) | undefined;
  const emit = (slug: string) => listeners.forEach((l) => l([{ scope: "project", project: slug }]));

  const add = (p: MockProject, c: NewCard, x: number, y: number) => {
    const card = mkCard(c);
    p.cards.set(card.id, card);
    p.canvas.cards[card.id] = { x, y };
    return card;
  };
  const inbox = seedProject("inbox", "Inbox");
  add(inbox, { title: "Pirate-radio fishing tips", body: "Chatty DJ narrates every catch." }, 0, 0);
  add(inbox, { title: "What if the lake bites first?" }, 264, 0);
  add(inbox, { title: "Neon bait", body: "Glows brighter the angrier the fish." }, 528, 0);
  projects.set("inbox", inbox);
  const fish = seedProject("fish-punk-fishing", "Fish-punk fishing");
  add(fish, { title: "Fish that fight back", body: "What if the lake bites first?" }, 0, 10);
  add(fish, { title: "Chill loop", body: "Cast, wait, let the combo breathe.", stage: "reverie" }, 290, -10);
  add(fish, { title: "Harpoon-rod hybrid", body: "One tool, two moods: patient and loud.", stage: "lucid" }, 540, 50);
  add(fish, { title: "Fish-punk: the dream", body: "Doom energy at a calm pace. Reel in a riff.", stage: "dream" }, 40, 230);
  add(fish, { title: "Rust-lake biome", body: "Neon bait glowing in oily water.", stage: "reverie", source: "claude", ghost: true }, 350, 260);
  projects.set(fish.slug, fish);

  // `npm run dev` + `?stress=1`: a 500-card project to eyeball pan/zoom/drag performance without Tauri.
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("stress")) {
    const stress = seedProject("stress-test", "Stress test (500 cards)");
    const stages = ["mist", "reverie", "lucid", "dream"] as const;
    for (let i = 0; i < 500; i++) {
      add(stress, { title: `Idea ${i}`, body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.", stage: stages[i % 4], tags: i % 3 === 0 ? ["tag"] : [] }, (i % 25) * 264, Math.floor(i / 25) * 196);
    }
    projects.set(stress.slug, stress);
  }

  const need = (slug: string) => {
    const p = projects.get(slug);
    if (!p) throw new Error(`not found: project ${slug}`);
    return p;
  };
  const editCard = (slug: string, id: string) => {
    const c = need(slug).cards.get(id);
    if (!c) throw new Error(`not found: card ${id}`);
    return c;
  };
  const touched = (slug: string, c: Card) => {
    c.updated = stamp();
    emit(slug);
    return structuredClone(c);
  };
  const summary = (p: MockProject): ProjectSummary => ({ slug: p.slug, name: p.name, theme: p.theme, card_count: p.cards.size, is_inbox: p.slug === "inbox", design_versions: p.design.length });
  const data = (p: MockProject): ProjectData => ({
    slug: p.slug, is_inbox: p.slug === "inbox", meta: { name: p.name, theme: p.theme ?? undefined, created: "", handoff_target: p.handoffTarget, handoff_target_confirmed: p.handoffConfirmed },
    canvas: structuredClone(p.canvas), folders: structuredClone(p.folders), canvases: structuredClone(p.canvases), cards: [...p.cards.values()].map((c) => structuredClone(c)), proposals: {}, warnings: [],
  });

  return {
    kind: "mock",
    workspaceInfo: async () => ({ root: "(in-memory demo data)", is_default: true }),
    setWorkspaceRoot: async () => ({ root: "(in-memory demo data)", is_default: true }),
    getSettings: async () => ({ ...settings }),
    updateSettings: async (patch) => {
      if (patch.theme) settings.theme = patch.theme;
      if (patch.hotkey) settings.hotkey = patch.hotkey;
      if (patch.last_project !== undefined) settings.last_project = patch.last_project || null;
      if (patch.show_projects !== undefined) settings.show_projects = patch.show_projects;
      if (patch.show_chat !== undefined) settings.show_chat = patch.show_chat;
      if (patch.tray_notice_shown !== undefined) settings.tray_notice_shown = patch.tray_notice_shown;
      if (patch.start_with_windows !== undefined) settings.start_with_windows = patch.start_with_windows;
      if (patch.start_hidden !== undefined) settings.start_hidden = patch.start_hidden;
      if (patch.model_chat !== undefined) settings.model_chat = patch.model_chat.trim() || "sonnet";
      if (patch.model_router !== undefined) settings.model_router = patch.model_router;
      if (patch.model_fast !== undefined) settings.model_fast = patch.model_fast.trim() || "haiku";
      if (patch.model_deep !== undefined) settings.model_deep = patch.model_deep.trim() || "opus";
      if (patch.model_export !== undefined) settings.model_export = patch.model_export.trim() || "opus";
      if (patch.model_memory !== undefined) settings.model_memory = patch.model_memory.trim() || "haiku";
      if (patch.compact_tokens !== undefined) settings.compact_tokens = patch.compact_tokens || 50000;
      if (patch.memory_cap !== undefined) settings.memory_cap = patch.memory_cap || 600;
      if (patch.local_chat !== undefined) settings.local_chat = patch.local_chat;
      if (patch.local_model !== undefined) settings.local_model = patch.local_model.trim() || "qwen3.5:35b-a3b";
      return { ...settings };
    },
    listProjects: async () => [...projects.values()].map(summary),
    createProject: async (name) => {
      // Same rule as Rust: one project per name (case-insensitive).
      const taken = [...projects.values()].find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (taken) throw new Error(`A project named “${taken.name}” already exists.`);
      let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
      while (projects.has(slug) || slug === "inbox") slug += "-2";
      const p = seedProject(slug, name.trim());
      projects.set(slug, p);
      return summary(p);
    },
    updateProject: async (slug, patch) => {
      const p = need(slug);
      if (patch.name && slug !== "inbox") p.name = patch.name;
      if (patch.theme !== undefined) p.theme = patch.theme || null;
      if (patch.handoff_target !== undefined) {
        const t = patch.handoff_target.trim();
        if (t !== p.handoffTarget) p.handoffConfirmed = undefined;
        p.handoffTarget = t || undefined;
      }
      if (patch.handoff_target_confirmed !== undefined) {
        if (patch.handoff_target_confirmed !== p.handoffTarget) throw new Error("only the current handoff folder can be confirmed");
        p.handoffConfirmed = p.handoffTarget;
      }
      return summary(p);
    },
    loadProject: async (slug) => data(need(slug)),
    saveCanvas: async (slug, canvas, folder) => {
      const p = need(slug);
      const c = { ...structuredClone(canvas), frames: structuredClone(canvas.frames ?? {}), folders: structuredClone(canvas.folders ?? {}), version: 3 };
      if (folder) p.canvases[folder] = c;
      else p.canvas = c;
    },
    saveLayout: async (slug, layout) => {
      const p = need(slug);
      if (layout.folders) {
        const keep = new Set(layout.folders.map((f) => f.id));
        p.folders = structuredClone(layout.folders);
        for (const k of Object.keys(p.canvases)) if (!keep.has(k)) delete p.canvases[k];
      }
      for (const [k, c] of Object.entries(layout.canvases)) {
        const v = { ...structuredClone(c), folders: structuredClone(c.folders ?? {}), version: 3 };
        if (k) p.canvases[k] = v;
        else p.canvas = v;
      }
      emit(slug);
    },
    deleteFolder: async (slug, id) => {
      const p = need(slug);
      const f = p.folders.find((x) => x.id === id);
      if (!f) throw new Error(`not found: folder ${id}`);
      const ids = subtreeOf(p, id);
      const canvases: Record<string, Canvas> = {};
      const cards: string[] = [];
      for (const k of ids) {
        canvases[k] = structuredClone(canvasOf(p, k));
        cards.push(...Object.keys(canvases[k].cards));
        delete p.canvases[k];
      }
      for (const c of cards) {
        const card = p.cards.get(c);
        if (card) p.trashed.set(c, card);
        p.cards.delete(c);
      }
      const parent = canvasOf(p, f.parent);
      const item: TrashItem = { id, title: f.title || "Untitled folder", stage: "mist", reason: "deleted", deleted_at: stamp(), pos: parent.folders[id] ?? null, kind: "folder", folder: f.parent, count: cards.length };
      delete parent.folders[id];
      p.trashedFolders.set(id, { folders: p.folders.filter((x) => ids.includes(x.id)), canvases, cards });
      p.folders = p.folders.filter((x) => !ids.includes(x.id));
      p.trash.push(item);
      emit(slug);
      return item;
    },
    createCard: async (slug, c) => {
      const p = need(slug);
      c = { ...c, role: checkRole(p, c.role) };
      const n = p.cards.size;
      const card = add(p, c, c.x ?? (n % 4) * 264, c.y ?? Math.floor(n / 4) * 196);
      if (c.folder) {
        canvasOf(p, c.folder).cards[card.id] = p.canvas.cards[card.id];
        delete p.canvas.cards[card.id];
      }
      emit(slug);
      return card;
    },
    readCard: async (slug, id) => {
      const c = need(slug).cards.get(id);
      if (!c) throw new Error(`not found: card ${id}`);
      return structuredClone(c);
    },
    updateCard: async (slug, id, patch) => {
      const p = need(slug);
      const c = p.cards.get(id);
      if (!c) throw new Error(`not found: card ${id}`);
      const { role, color, items, attachments, ...rest } = patch;
      const next: Card = { ...c, ...rest };
      if (role !== undefined) {
        const r = checkRole(p, role, id);
        if (r) next.role = r;
        else delete next.role;
      }
      if (color !== undefined) {
        const cc = cleanColor(color);
        if (cc) next.color = cc;
        else delete next.color;
      }
      if (items !== undefined) next.items = checkItems(items);
      if (attachments !== undefined) next.attachments = checkAttachments(attachments);
      Object.assign(c, next, { updated: stamp() });
      emit(slug);
      return structuredClone(c);
    },
    addAttachment: async (slug, id, att) => {
      const c = editCard(slug, id);
      const a = { ...att, id: att.id ?? "" } as Attachment;
      checkAttachment(a);
      if (!a.id.trim() || c.attachments.some((o) => o.id === a.id)) a.id = nid();
      c.attachments.push(a);
      return touched(slug, c);
    },
    updateAttachment: async (slug, id, attId, patch) => {
      const c = editCard(slug, id);
      const i = c.attachments.findIndex((a) => a.id === attId);
      if (i < 0) throw new Error(`not found: attachment ${attId}`);
      const next: Record<string, unknown> = { ...c.attachments[i] };
      for (const [k, v] of Object.entries(patch)) {
        if (k === "id" || k === "type") continue;
        if (v === null) delete next[k];
        else next[k] = v;
      }
      checkAttachment(next as unknown as Attachment);
      c.attachments[i] = next as unknown as Attachment;
      return touched(slug, c);
    },
    removeAttachment: async (slug, id, attId) => {
      const c = editCard(slug, id);
      const before = c.attachments.length;
      c.attachments = c.attachments.filter((a) => a.id !== attId);
      if (c.attachments.length === before) throw new Error(`not found: attachment ${attId}`);
      return touched(slug, c);
    },
    reorderAttachments: async (slug, id, ids) => {
      const c = editCard(slug, id);
      const bad = ids.find((i) => !c.attachments.some((a) => a.id === i));
      if (bad) throw new Error(`not found: attachment ${bad}`);
      const listed = ids.flatMap((i) => c.attachments.filter((a) => a.id === i).slice(0, 1));
      c.attachments = [...listed, ...c.attachments.filter((a) => !listed.includes(a))];
      return touched(slug, c);
    },
    deleteCard: async (slug, id) => {
      const p = need(slug);
      const c = p.cards.get(id);
      if (!c) throw new Error(`not found: card ${id}`);
      const folder = locate(p, id);
      const item: TrashItem = { id, title: c.title, stage: c.stage, reason: "deleted", deleted_at: stamp(), pos: canvasOf(p, folder).cards[id] ?? null, folder };
      p.trash.push(item);
      p.cards.delete(id);
      delete canvasOf(p, folder).cards[id];
      p.trashed.set(id, c);
      emit(slug);
      return item;
    },
    loseCard: async (slug, id, reason) => {
      const p = need(slug);
      const c = p.cards.get(id);
      if (!c) throw new Error(`not found: card ${id}`);
      const folder = locate(p, id);
      const item: TrashItem = { id, title: c.title, stage: c.stage, reason, deleted_at: stamp(), pos: canvasOf(p, folder).cards[id] ?? null, folder };
      p.trash.push(item);
      p.cards.delete(id);
      delete canvasOf(p, folder).cards[id];
      p.trashed.set(id, c);
      emit(slug);
      return item;
    },
    listTrash: async (slug) => [...need(slug).trash],
    restoreCard: async (slug, id) => {
      const p = need(slug);
      const bundle = p.trashedFolders.get(id);
      const fitem = p.trash.find((t) => t.id === id && t.kind === "folder");
      if (bundle && fitem) {
        const parent = fitem.folder && p.folders.some((f) => f.id === fitem.folder) ? fitem.folder : null;
        p.folders.push(...bundle.folders.map((f) => (f.id === id ? { ...f, parent } : f)));
        Object.assign(p.canvases, bundle.canvases);
        for (const c of bundle.cards) {
          const card = p.trashed.get(c);
          if (card) p.cards.set(c, card);
          p.trashed.delete(c);
        }
        canvasOf(p, parent).folders[id] = fitem.pos ?? { x: 0, y: 0 };
        p.trashedFolders.delete(id);
        p.trash = p.trash.filter((t) => t.id !== id);
        emit(slug);
        return { folder: id };
      }
      const c = p.trashed.get(id);
      const item = p.trash.find((t) => t.id === id);
      if (!c || !item) throw new Error(`not found: trash item ${id}`);
      // A restored Tech card yields its role if another card took it meanwhile.
      if (c.role === "tech" && [...p.cards.values()].some((o) => o.role === "tech")) delete c.role;
      p.cards.set(id, c);
      const into = item.folder && p.folders.some((f) => f.id === item.folder) ? item.folder : null;
      canvasOf(p, into).cards[id] = item.pos ?? { x: 0, y: 0 };
      p.trash = p.trash.filter((t) => t.id !== id);
      p.trashed.delete(id);
      emit(slug);
      return structuredClone(c);
    },
    emptyTrash: async (slug) => {
      const p = need(slug);
      const n = p.trash.length;
      p.trash = [];
      p.trashed.clear();
      return n;
    },
    saveMedia: async (_slug, files) =>
      files.map(({ name_hint, bytes }) => {
        const ext = name_hint.split(".").pop()?.toLowerCase() || "png";
        const url = URL.createObjectURL(new Blob([bytes] as BlobPart[]));
        return `mock:${url}#.${ext}`;
      }),
    dismissProposal: async () => {},
    restoreProposal: async () => {},
    fetchClip: async (_slug, url) => {
      await new Promise((r) => setTimeout(r, 400));
      let host = "";
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return { id: nid(), type: "clip", url, fetch_error: "not an http(s) URL", fetched_at: new Date().toISOString() };
      }
      return { id: nid(), type: "clip", url, title: host, site: host, description: "Mock clip: no network in the browser preview.", fetched_at: new Date().toISOString() };
    },
    refreshClip: async (slug, id, attId) => {
      const c = editCard(slug, id);
      const a = c.attachments.find((x) => x.id === attId);
      if (!a || a.type !== "clip") throw new Error(`not found: clip ${attId}`);
      a.fetched_at = new Date().toISOString();
      delete a.fetch_error;
      return touched(slug, c);
    },
    openUrl: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    readMedia: async (_slug, rel) => (rel.startsWith("mock:") ? rel.slice(5).split("#")[0] : rel),
    // The browser preview fakes the handoff session: a few progress events, then canned docs.
    handoffStart: async (slug, mode, spec, gaps) => {
      const p = need(slug);
      if (handoffTimer) throw new Error("A handoff session is already running.");
      const cards = [...p.cards.values()].filter((c) => !c.ghost && (c.kind !== "sticky" || spec.include_stickies) && (c.kind !== "card" || c.role || spec.stages.includes(c.stage)));
      if (!cards.length) throw new Error("Nothing to summarize: no cards match this scope and these stages.");
      const job = `hmock${++seq}`;
      const steps: HandoffEventBody[] = [{ type: "progress", step: "reading", read: 0, total: cards.length }];
      // Fake live activity: one read_card step per card and rising token counts.
      const t0 = Date.now();
      steps.push({ type: "step", step: { sid: "l1", kind: "tool", tool: "list_cards", label: "Listed cards", status: "done", startedAt: t0, endedAt: t0 } });
      cards.forEach((c, i) => {
        steps.push({ type: "step", step: { sid: `r${i}`, kind: "tool", tool: "read_card", label: "Reading a card", status: "running", startedAt: t0 } });
        steps.push({ type: "step", step: { sid: `r${i}`, kind: "tool", tool: "read_card", label: `Read "${c.title}"`, status: "done", startedAt: t0, endedAt: t0 } });
        steps.push({ type: "usage", input: 2000 + i * 900, cacheRead: 8000 * (i + 1), cacheCreate: 0, output: 60 * (i + 1) });
        steps.push({ type: "progress", step: "reading", read: i + 1, total: cards.length });
      });
      if (mode === "gaps") {
        steps.push({ type: "gaps", gaps: GAP_CHECKLIST.map((item, i) => ({ item, status: i % 3 === 0 ? "ok" : i % 3 === 1 ? "thin" : "missing", note: "Mock result (browser preview)." })) }, { type: "done", mode: "gaps" });
      } else {
        const version = p.design.length + 1;
        const docs: Record<string, string> = {};
        DESIGN_DOCS.forEach((name, i) => {
          docs[name] = name === "CHANGELOG.md" ? `# Changelog\n\n## v${version}\n\n${version === 1 ? "Initial version" : "Regenerated."}\n` : `# ${name}\n\nMock ${name} for **${p.name}** (browser preview).\n\n## Cards\n\n${cards.map((c) => `- ${c.title}`).join("\n")}\n\n- [ ] M1-T1: TBD\n${gaps?.length ? `\n## Known gaps\n\n${gaps.map((g) => `- TBD: ${g.item}`).join("\n")}\n` : ""}`;
          if (i < 7) {
            steps.push({ type: "step", step: { sid: `w${i}`, kind: "tool", tool: "write_design_doc", label: `Wrote ${name}`, status: "done", startedAt: t0, endedAt: t0 } });
            steps.push({ type: "progress", step: "writing", doc: name, written: i + 1, of: 7 });
          }
        });
        steps.push({ type: "progress", step: "copying" });
        const entry: DesignVersion = { version, created: new Date().toISOString(), model: settings.model_export, scope: spec.scope.kind, docs: [...DESIGN_DOCS], cards: cards.length };
        steps.push({ type: "done", mode: "generate", version, dir: `(in-memory)/design/v${version}`, warnings: [], repo: p.handoffTarget && p.handoffConfirmed === p.handoffTarget ? { path: p.handoffTarget, files: [] } : null });
        handoffCommit = () => p.design.push({ entry, docs });
      }
      const tick = () => {
        const e = steps.shift();
        if (!e) {
          handoffTimer = undefined;
          return;
        }
        if (e.type === "done" && e.mode === "generate") handoffCommit?.();
        handoffListeners.forEach((l) => l({ ...e, job }));
        handoffTimer = setTimeout(tick, 250);
      };
      handoffTimer = setTimeout(tick, 250);
      return job;
    },
    handoffCancel: async () => {
      clearTimeout(handoffTimer);
      handoffTimer = undefined;
      handoffCommit = undefined;
    },
    onHandoffEvent: async (cb) => {
      handoffListeners.add(cb);
      return () => handoffListeners.delete(cb);
    },
    listDesignVersions: async (slug) => need(slug).design.map((d) => structuredClone(d.entry)),
    readDesignDoc: async (slug, version, name) => {
      const d = need(slug).design.find((x) => x.entry.version === version);
      const t = d?.docs[name];
      if (t === undefined) throw new Error(`not found: design/v${version}/${name}`);
      return t;
    },
    openDesignFolder: async () => {},
    openLogsFolder: async () => {},
    pickFolder: async () => (typeof window !== "undefined" ? window.prompt("Repo folder (browser preview)") : null),
    searchCards: async (query, project, limit = 20) => {
      const words = foldText(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.replace(/(ing|ed|es|s)$/, ""));
      if (!words.length) return [];
      const hits: SearchHit[] = [];
      for (const p of projects.values()) {
        if (project && p.slug !== project) continue;
        for (const c of p.cards.values()) {
          const score = mockScore(c, words);
          if (score > 0) {
            hits.push({ id: c.id, project: p.slug, project_name: p.name, title: c.title, stage: c.stage, tags: c.tags, ghost: c.ghost, kind: c.kind, snippet: c.body.slice(0, 200), score });
          }
        }
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    deleteProject: async (slug) => {
      if (slug === "inbox") throw new Error("The Inbox can't be deleted.");
      need(slug);
      projects.delete(slug);
      if (settings.last_project === slug) settings.last_project = null;
      listeners.forEach((l) => l([{ scope: "project", project: slug }]));
      return { slug, path: `(in-memory)/projects/${slug}`, recycled: true };
    },
    loadChat: async (slug, thread) => structuredClone(chats.get(`${slug}/${thread}`) ?? { version: 1, messages: [] }),
    saveChat: async (slug, thread, data) => {
      chats.set(`${slug}/${thread}`, structuredClone(data));
    },
    resetChat: async (slug, thread) => {
      chats.delete(`${slug}/${thread}`);
    },
    listCustomThemes: async () => [...customThemes.values()],
    saveCustomTheme: async (id, theme) => {
      customThemes.set(id, theme);
    },
    deleteCustomTheme: async (id) => {
      customThemes.delete(id);
    },
    memoryGet: async (slug) => memView(slug),
    memorySave: async (slug, text, source) => {
      const before = memories.get(slug);
      const after = mockRender(mockParse(text));
      if (before !== after) {
        memories.set(slug, after);
        memLog(slug).unshift({ at: new Date().toISOString(), source, thread: null, ops: [{ op: "edit" }], before: before ?? "", after });
      }
      return memView(slug);
    },
    memoryHistory: async (slug) => structuredClone(memLog(slug)),
    memoryRevert: async (slug, at) => {
      const e = memLog(slug).find((x) => x.at === at);
      if (!e) throw new Error("not found");
      const before = memories.get(slug) ?? "";
      memories.set(slug, e.before || mockRender(mockParse("")));
      memLog(slug).unshift({ at: new Date().toISOString(), source: "user", thread: null, ops: [{ op: "revert", at }], before, after: memories.get(slug)! });
      return memView(slug);
    },
    memoryUndo: async () => {},
    memorySeed: async (slug) => {
      setTimeout(() => memoryListeners.forEach((l) => l({ type: "seed", slug, text: mockRender(mockParse("## Pitch\n- A calm cooperative sea-farming game\n## Decisions\n- Solo and co-op only, no PvP")) })), 600);
    },
    onMemoryEvent: async (cb) => {
      memoryListeners.add(cb);
      return () => memoryListeners.delete(cb);
    },
    // In a plain browser there is no tray or process to quit.
    quitApp: async () => {},
    autostartEnabled: async () => settings.start_with_windows,
    setAutostart: async (enabled) => ((settings.start_with_windows = enabled), enabled),
    hideToTray: async () => {},
    onTrayNotice: async () => () => {},
    onChange: async (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
