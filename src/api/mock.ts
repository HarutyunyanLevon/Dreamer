import type { Api, Canvas, Card, ChangeEvent, NewCard, ProjectData, ProjectSummary, Settings, TrashItem } from "./types";

/**
 * In-memory stand-in so `npm run dev` (plain browser) and screenshots work without the Rust core.
 * It mirrors the command signatures only loosely: the real behavior is tested in Rust.
 */
interface MockProject {
  slug: string;
  name: string;
  theme: string | null;
  canvas: Canvas;
  cards: Map<string, Card>;
  trash: TrashItem[];
  trashed: Map<string, Card>;
}

let seq = 0;
const nid = () => `01MOCK${String(++seq).padStart(20, "0")}`;
const stamp = () => new Date().toISOString();

function mkCard(c: NewCard): Card {
  const t = stamp();
  return {
    id: nid(), title: c.title?.trim() || "Untitled", stage: c.stage ?? "cloud", tags: c.tags ?? [], fields: c.fields ?? {},
    created: t, updated: t, source: c.source ?? "user", ghost: c.ghost ?? false, links: c.links ?? [], body: c.body ?? "",
  };
}

function seedProject(slug: string, name: string): MockProject {
  return { slug, name, theme: null, canvas: { version: 1, viewport: { x: 300, y: 110, zoom: 1 }, cards: {} }, cards: new Map(), trash: [], trashed: new Map() };
}

export function createMockApi(): Api {
  const settings: Settings = { version: 1, theme: "pearl-glow", hotkey: "Ctrl+Shift+Space", last_project: null };
  const projects = new Map<string, MockProject>();
  const listeners = new Set<(e: ChangeEvent[]) => void>();
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
  add(fish, { title: "Chill loop", body: "Cast, wait, let the combo breathe.", stage: "sketch" }, 290, -10);
  add(fish, { title: "Harpoon-rod hybrid", body: "One tool, two moods: patient and loud.", stage: "draft" }, 540, 50);
  add(fish, { title: "Fish-punk: the pitch", body: "Doom energy at a calm pace. Reel in a riff.", stage: "pitch" }, 40, 230);
  add(fish, { title: "Rust-lake biome", body: "Neon bait glowing in oily water.", stage: "sketch", source: "claude", ghost: true }, 350, 260);
  projects.set(fish.slug, fish);

  const need = (slug: string) => {
    const p = projects.get(slug);
    if (!p) throw new Error(`not found: project ${slug}`);
    return p;
  };
  const summary = (p: MockProject): ProjectSummary => ({ slug: p.slug, name: p.name, theme: p.theme, card_count: p.cards.size, is_inbox: p.slug === "inbox" });
  const data = (p: MockProject): ProjectData => ({
    slug: p.slug, is_inbox: p.slug === "inbox", meta: { name: p.name, theme: p.theme ?? undefined, created: "" },
    canvas: structuredClone(p.canvas), cards: [...p.cards.values()].map((c) => structuredClone(c)), warnings: [],
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
      return { ...settings };
    },
    listProjects: async () => [...projects.values()].map(summary),
    createProject: async (name) => {
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
      return summary(p);
    },
    loadProject: async (slug) => data(need(slug)),
    saveCanvas: async (slug, canvas) => { need(slug).canvas = structuredClone(canvas); },
    createCard: async (slug, c) => {
      const p = need(slug);
      const n = p.cards.size;
      const card = add(p, c, c.x ?? (n % 4) * 264, c.y ?? Math.floor(n / 4) * 196);
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
      Object.assign(c, patch, { updated: stamp() });
      emit(slug);
      return structuredClone(c);
    },
    deleteCard: async (slug, id) => {
      const p = need(slug);
      const c = p.cards.get(id);
      if (!c) throw new Error(`not found: card ${id}`);
      const item: TrashItem = { id, title: c.title, stage: c.stage, reason: "deleted", deleted_at: stamp(), pos: p.canvas.cards[id] ?? null };
      p.trash.push(item);
      p.cards.delete(id);
      delete p.canvas.cards[id];
      p.trashed.set(id, c);
      emit(slug);
      return item;
    },
    loseCard: async (slug, id, reason) => {
      const p = need(slug);
      const c = p.cards.get(id);
      if (!c) throw new Error(`not found: card ${id}`);
      const item: TrashItem = { id, title: c.title, stage: c.stage, reason, deleted_at: stamp(), pos: p.canvas.cards[id] ?? null };
      p.trash.push(item);
      p.cards.delete(id);
      delete p.canvas.cards[id];
      p.trashed.set(id, c);
      emit(slug);
      return item;
    },
    listTrash: async (slug) => [...need(slug).trash],
    restoreCard: async (slug, id) => {
      const p = need(slug);
      const c = p.trashed.get(id);
      const item = p.trash.find((t) => t.id === id);
      if (!c || !item) throw new Error(`not found: trash item ${id}`);
      p.cards.set(id, c);
      p.canvas.cards[id] = item.pos ?? { x: 0, y: 0 };
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
    saveMedia: async (_slug, nameHint, bytes) => {
      const ext = nameHint.split(".").pop()?.toLowerCase() || "png";
      const blob = new Blob([bytes] as BlobPart[]);
      const url = URL.createObjectURL(blob);
      return `mock:${url}#.${ext}`;
    },
    readMedia: async (_slug, rel) => (rel.startsWith("mock:") ? rel.slice(5).split("#")[0] : rel),
    onChange: async (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
