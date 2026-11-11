import type { StageId } from "../theme/types";

export interface Link {
  to: string;
  label?: string;
}

export interface Card {
  id: string;
  title: string;
  stage: StageId;
  tags: string[];
  fields: Record<string, unknown>;
  created: string;
  updated: string;
  source: "user" | "claude";
  ghost: boolean;
  links: Link[];
  branch?: unknown;
  body: string;
  /** Any other frontmatter keys found in the file are passed through untouched. */
  [extra: string]: unknown;
}

export interface NewCard {
  title?: string;
  body?: string;
  stage?: StageId;
  tags?: string[];
  fields?: Record<string, unknown>;
  links?: Link[];
  source?: "user" | "claude";
  ghost?: boolean;
  x?: number;
  y?: number;
}

export type CardPatch = Partial<Pick<Card, "title" | "body" | "stage" | "tags" | "fields" | "links" | "ghost">>;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}
export interface Pos {
  x: number;
  y: number;
  /** Present once the user has resized the card (absent = default width, auto height). */
  w?: number;
  h?: number;
  /** Stacking order; higher is in front. */
  z?: number;
  /** The user explicitly sent this card to the back: never auto-raise it. */
  back?: boolean;
}
export interface Canvas {
  version: number;
  viewport: Viewport;
  cards: Record<string, Pos>;
}

export interface ProjectMeta {
  name: string;
  theme?: string;
  created: string;
}
export interface ProjectSummary {
  slug: string;
  name: string;
  theme: string | null;
  card_count: number;
  is_inbox: boolean;
}
export interface ProjectData {
  slug: string;
  is_inbox: boolean;
  meta: ProjectMeta;
  canvas: Canvas;
  cards: Card[];
  warnings: string[];
}

export interface Settings {
  version: number;
  theme: string;
  hotkey: string;
  last_project: string | null;
}
export interface SettingsPatch {
  theme?: string;
  hotkey?: string;
  /** Empty string clears it. */
  last_project?: string;
}

export interface TrashItem {
  id: string;
  title: string;
  stage: StageId;
  reason: string;
  deleted_at: string;
  pos: { x: number; y: number } | null;
}

export interface WorkspaceInfo {
  root: string;
  is_default: boolean;
}

export interface ChangeEvent {
  scope: "project" | "settings" | "themes";
  project: string | null;
}

/** One result of `search_cards` (keyword search over card files; see src-tauri/src/search.rs). */
export interface SearchHit {
  id: string;
  project: string;
  project_name: string;
  title: string;
  stage: StageId;
  tags: string[];
  ghost: boolean;
  snippet: string;
  score: number;
}

export interface Api {
  /** "tauri" talks to the Rust core; "mock" is an in-memory stand-in for browser dev. */
  kind: "tauri" | "mock";
  workspaceInfo(): Promise<WorkspaceInfo>;
  setWorkspaceRoot(path: string): Promise<WorkspaceInfo>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(name: string): Promise<ProjectSummary>;
  updateProject(slug: string, patch: { name?: string; theme?: string }): Promise<ProjectSummary>;
  loadProject(slug: string): Promise<ProjectData>;
  saveCanvas(slug: string, canvas: Canvas): Promise<void>;
  createCard(slug: string, card: NewCard): Promise<Card>;
  readCard(slug: string, id: string): Promise<Card>;
  updateCard(slug: string, id: string, patch: CardPatch): Promise<Card>;
  deleteCard(slug: string, id: string): Promise<TrashItem>;
  /** Trash with a custom reason, e.g. "lost to <winner title>" when picking a fork's winner. */
  loseCard(slug: string, id: string, reason: string): Promise<TrashItem>;
  listTrash(slug: string): Promise<TrashItem[]>;
  restoreCard(slug: string, id: string): Promise<Card>;
  emptyTrash(slug: string): Promise<number>;
  /** Saves bytes under the project's media/ folder; returns the path to store in a card's fields (e.g. "media/xyz.png"). */
  saveMedia(slug: string, nameHint: string, bytes: Uint8Array): Promise<string>;
  /** Reads a file back from inside the project (e.g. a media/ path) as a data: URL. */
  readMedia(slug: string, rel: string): Promise<string>;
  /** Files changed on disk (by this app, Claude Code, git...). Returns an unsubscribe function. */
  onChange(cb: (events: ChangeEvent[]) => void): Promise<() => void>;
  /** Only succeeds once the card has reached Pitch; returns the relative path written under briefs/. */
  exportBrief(slug: string, id: string): Promise<string>;
  /** Keyword search; `project` omitted = every project. Read-only, no Claude involved. */
  searchCards(query: string, project?: string, limit?: number): Promise<SearchHit[]>;
  listCustomThemes(): Promise<unknown[]>;
  saveCustomTheme(id: string, theme: unknown): Promise<void>;
  deleteCustomTheme(id: string): Promise<void>;
}
