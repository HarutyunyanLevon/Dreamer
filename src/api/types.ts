import type { StageId } from "../theme/types";
import type { ActivityStep, TokenUsage } from "./claude";

export interface Link {
  to: string;
  label?: string;
}

export type CardKind = "card" | "checklist" | "image" | "clip" | "artifact";

export type ArtifactType = "theme" | "character" | "concept" | "mockup";
/** "pixel" (with a pixel size) or "hd". */
export interface ArtMode {
  mode: "pixel" | "hd";
  pixelSize?: number;
}
interface ThemeSpec {
  palette: { name: string; hex: string }[];
  fonts: { heading: string; body: string };
  mood: string[];
  dos: string[];
  donts: string[];
  artMode?: ArtMode;
  /** The key art file in the theme's version. */
  keyArt?: string;
  keyArtAssetId?: string;
  presetId?: string;
}
export interface ArtifactFile {
  file: string;
  assetId?: string;
  role?: string;
}
export interface ArtifactVersion {
  n: number;
  parent?: number;
  created: string;
  files: ArtifactFile[];
  theme?: ThemeSpec;
  credits: number;
}
interface ArtifactSuggestion {
  label: string;
  prompt: string;
  estCredits?: number;
}
/** artifact.json plus what it inherits (artifact_get). */
export interface ArtifactView {
  id: string;
  type: ArtifactType;
  title: string;
  themeId?: string;
  artMode?: ArtMode;
  currentVersion: number;
  approvedVersion?: number;
  versions: ArtifactVersion[];
  suggestions: ArtifactSuggestion[];
  sourceCard?: string;
  brief: string;
  inherited: { id: string; title: string; version: number; spec: ThemeSpec } | null;
  effectiveArtMode: ArtMode | null;
  isActiveTheme: boolean;
  activeTheme: string | null;
}
export interface NewArtifact {
  type: ArtifactType;
  title?: string;
  brief: string;
  sourceCard?: string;
  themeId?: string;
  ghost?: boolean;
  x?: number;
  y?: number;
}
/** `themeId: ""` / `artMode: null` clear the override; `approvedVersion: 0` clears the approval. */
interface ArtifactPatch {
  themeId?: string;
  artMode?: ArtMode | null;
  currentVersion?: number;
  approvedVersion?: number;
}
export interface ArtifactThemeRef {
  id: string;
  title: string;
  active: boolean;
  versions: number;
  spec: ThemeSpec | null;
}
export interface ArtifactVersionInfo {
  brief: string;
  notes: string;
  meta: { parent?: number | null; model?: string | null; credits?: number; jobs?: string[]; created?: string } | null;
}
/** "tech" = the project's Tech & constraints card; "decisions" = the Project decisions card.
 *  At most one live card per role per project. */
export type CardRole = "tech" | "decisions";

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** An open question rather than a to-do. */
  question?: boolean;
  answer?: string;
}

/** Paths are project-relative and always under media/. */
export interface ImageAttachment {
  id: string;
  type: "image";
  path: string;
  caption?: string;
}
export interface ClipAttachment {
  id: string;
  type: "clip";
  url: string;
  title?: string;
  description?: string;
  site?: string;
  favicon?: string;
  thumb?: string;
  /** media/clips/<id>.md */
  excerpt?: string;
  caption?: string;
  fetched_at?: string;
  fetch_error?: string;
}
export type Attachment = ImageAttachment | ClipAttachment;
/** For addAttachment: the id may be left out (the core assigns one). */
type NewAttachment = (Omit<ImageAttachment, "id"> | Omit<ClipAttachment, "id">) & { id?: string };
/** Keys to change; `null` clears an optional key. `id`/`type` are ignored. */
type AttachmentPatch = Partial<Record<Exclude<keyof ImageAttachment | keyof ClipAttachment, "id" | "type">, string | null>>;

interface MediaUpload {
  name_hint: string;
  bytes: Uint8Array;
}

export interface Card {
  id: string;
  title: string;
  kind: CardKind;
  role?: CardRole;
  /** Checklist kind. */
  items?: ChecklistItem[];
  /** Display order; the first image is the cover. */
  attachments: Attachment[];
  stage: StageId;
  tags: string[];
  fields: Record<string, unknown>;
  created: string;
  updated: string;
  source: "user" | "claude";
  ghost: boolean;
  links: Link[];
  branch?: unknown;
  /** On a merge ghost: the ids of the cards it replaces when kept. */
  merged_from?: string[];
  /** The .dreamer.md bundle and ref this card was imported from. */
  import?: { bundle_id: string; ref: string; source: string };
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
  kind?: CardKind;
  role?: CardRole;
  items?: ChecklistItem[];
  attachments?: Attachment[];
  /** Fork marker: {group, of} (see BranchCompare). */
  branch?: unknown;
  x?: number;
  y?: number;
}

/** `role: ""` clears it. */
export type CardPatch = Partial<Pick<Card, "title" | "body" | "stage" | "tags" | "fields" | "links" | "ghost" | "kind" | "items" | "attachments">> & {
  role?: CardRole | "";
};

interface Viewport {
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
  /** Position pinned: drags and align/distribute leave it in place. */
  pinned?: boolean;
}
/** A titled region drawn behind cards; saved through saveCanvas. */
export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color?: string;
  z: number;
}
export interface Canvas {
  /** 2 added frames; older files load without. */
  version: number;
  viewport: Viewport;
  cards: Record<string, Pos>;
  frames: Record<string, Frame>;
}

interface ProjectMeta {
  name: string;
  theme?: string;
  created: string;
  /** Repo folder the handoff pack is copied into. */
  handoff_target?: string;
  /** The target the user confirmed writing into (first use). Copying needs it to equal handoff_target. */
  handoff_target_confirmed?: string;
}
export interface ProjectSummary {
  slug: string;
  name: string;
  theme: string | null;
  card_count: number;
}
export interface ProjectData {
  slug: string;
  meta: ProjectMeta;
  /** The project's one canvas. */
  canvas: Canvas;
  cards: Card[];
  /** Pending Claude edit proposals by card id (cards/<id>.proposal.json). */
  proposals?: Record<string, EditProposal>;
  warnings: string[];
}

/** Arrange layouts of an organize plan. */
export type OrganizeLayout = "grid" | "cluster-by-tag" | "flow-by-links" | "stage-columns";
/** One op of an organize plan, as validated by Rust. */
export type OrganizeOp =
  | { op: "rename"; id: string; title: string }
  | { op: "create_frame"; tempId: string; title: string; color?: string; rect: { x: number; y: number; w: number; h: number } }
  | { op: "arrange"; ids: string[]; layout: OrganizeLayout }
  /** Explicit positions (the organize pipeline lays cards out itself). */
  | { op: "place"; positions: Record<string, { x: number; y: number }> }
  | { op: "retag"; id: string; add: string[]; remove: string[] };
export type OrganizeScope = "project" | "frame" | "selection";
/** A propose_organize plan (validated whole; nothing applied until the user does). */
export interface OrganizePlanData {
  slug: string;
  scope: OrganizeScope;
  /** The cards in scope (frame / selection); null = the whole project. */
  scopeIds?: string[] | null;
  scopeName: string;
  rationale: string;
  ops: OrganizeOp[];
  /** Pinned items the plan leaves where they are. */
  kept: { id: string; title: string }[];
  /** Titles of the existing cards / frames the ops name. */
  titles: Record<string, string>;
  /** A pipeline plan where some cards could not be placed (they are listed in `unplaced`). */
  partial?: boolean;
  unplaced?: { id: string; title: string }[];
  /** The organize pipeline's state (groups, assignments), for finishing a partial plan. */
  pipeline?: { groups: { id: string; title: string; purpose: string }[]; problems?: string[] } & Record<string, unknown>;
}

export interface ImportTarget {
  project?: string;
  /** "" = no default frame. */
  frame?: string;
  at?: [number, number];
  open_project?: string;
}
export interface ImportPlan {
  header: { bundle_id: string; title: string; project?: string; frame?: string; source: string; created: string };
  project: string;
  frame: string | null;
  unresolved: "project"[];
  projects: { slug: string; name: string }[];
  frames: string[];
  cards: { ref: string; title: string; stage: StageId; action: "new" | "update" | "replace"; card_id: string | null; frame: string | null }[];
  warnings: string[];
}
export interface ImportResult {
  project: string;
  created: string[];
  proposals: string[];
  replaced: string[];
  frames: string[];
  warnings: string[];
}
export interface ImportOffer {
  path: string;
  title: string;
  source: string;
  count: number;
}

/** A change Claude proposed for one card (propose_edit). Only the listed keys change. */
export interface EditProposal {
  title?: string;
  body?: string;
  tags?: string[];
  stage?: StageId;
  /** New captions keyed by attachment id. */
  captions?: Record<string, string>;
  reason?: string;
  created?: string;
}

export interface Settings {
  version: number;
  theme: string;
  last_project: string | null;
  /** Left panel (projects) shown. */
  show_projects: boolean;
  /** Right panel (Claude chat) shown. */
  show_chat: boolean;
  /** Panel widths in px (left 180-420, chat 280-720); absent in the in-memory demo. */
  side_w?: number;
  chat_w?: number;
  /** Claude model for chat sessions (alias like "sonnet" or a full id). */
  model_chat: string;
  /** Route chat turns between the fast / main (model_chat) / deep models. */
  model_router: boolean;
  model_fast: string;
  model_deep: string;
  /** Claude model for the handoff pack session. */
  model_export: string;
  /** Claude model for thread summaries (auto-compact). */
  model_memory: string;
  /** Summarize a thread into a fresh session once a turn read more input tokens than this. */
  compact_tokens: number;
  /** Word cap of a project's memory.md. */
  memory_cap: number;
  /** SpriteCook's remote MCP server (artifact images); the key is in the OS credential store. */
  spritecook_url: string;
  /** Paid SpriteCook calls an artifact turn makes before it asks. */
  credit_cap: number;
}
/** The stored SpriteCook key (masked) and server URL. */
export interface SpritecookKeyStatus {
  hasKey: boolean;
  masked?: string | null;
  url: string;
}
interface SettingsPatch {
  theme?: string;
  /** Empty string clears it. */
  last_project?: string;
  show_projects?: boolean;
  show_chat?: boolean;
  side_w?: number;
  chat_w?: number;
  /** Empty string restores the default. */
  model_chat?: string;
  model_router?: boolean;
  model_fast?: string;
  model_deep?: string;
  model_export?: string;
  model_memory?: string;
  /** 0 restores the default. */
  compact_tokens?: number;
  /** 0 restores the default. */
  memory_cap?: number;
  /** Empty string restores the default. */
  spritecook_url?: string;
  /** 0 restores the default. */
  credit_cap?: number;
}

/** A project's memory (`<project>/memory.md`): bullets under six fixed sections, capped in words. */
export interface MemoryView {
  exists: boolean;
  /** Normalized text (the empty template when there is no file yet). */
  text: string;
  words: number;
  cap: number;
}

interface MemoryOp {
  op: "add" | "replace" | "remove" | "edit" | "revert";
  section?: string;
  text?: string;
  old?: string;
  at?: string;
}

/** One line of `memory.log.jsonl`. */
export interface MemoryLogEntry {
  at: string;
  source: "auto" | "user" | "claude" | "seed";
  thread: string | null;
  ops: MemoryOp[];
  before: string;
  after: string;
}

/** `memory-event`: a seed draft (nothing is written until the user chooses) or its failure. */
export type MemoryEvent = { type: "seed"; slug: string; text: string } | { type: "seed_error"; slug: string };

export interface TrashItem {
  id: string;
  title: string;
  stage: StageId;
  reason: string;
  deleted_at: string;
  pos: { x: number; y: number } | null;
}

interface WorkspaceInfo {
  root: string;
  is_default: boolean;
}

export interface ChangeEvent {
  scope: "project" | "settings" | "memory" | "artifact";
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
  /** Missing from older cores = "card". */
  kind?: CardKind;
  snippet: string;
  score: number;
}

interface DeletedProject {
  slug: string;
  path: string;
  /** true = moved to the Recycle Bin; false = deleted outright. */
  recycled: boolean;
}

/** One chat thread's file (`<project>/chats/<card id | project>.json`). */
export interface ChatThreadFile {
  version: number;
  /** Claude session to resume for this thread. */
  sessionId?: string;
  messages: unknown[];
  /** Rust-owned (kept across saves): context snapshot, last input tokens, thread summary. */
  ctx?: unknown;
  last_input_tokens?: number;
  /** The model's context window at the last turn (Rust-owned). */
  context_window?: number;
  summary?: string;
}

// ----- the project handoff pack (src-tauri/src/handoff.rs) -----

export type HandoffScope = { kind: "project" } | { kind: "selection"; ids: string[] } | { kind: "frames"; ids: string[] } | { kind: "card"; id: string };
export interface HandoffSpec {
  scope: HandoffScope;
  /** Stages of plain cards to include (other kinds have no stage and are always in). */
  stages: StageId[];
}
/** What a finished pack wrote into the linked repo folder. */
export interface HandoffRepoResult {
  path: string;
  files: string[];
  warnings: string[];
}
export type HandoffEventBody =
  | { type: "progress"; step: "reading"; read: number; total: number; images?: number }
  | { type: "progress"; step: "viewing"; viewed: number; images: number }
  | { type: "progress"; step: "writing"; doc: string; written: number; of: number }
  | { type: "progress"; step: "copying" }
  | { type: "note"; step: string; note: string }
  | ({ type: "done" } & HandoffRepoResult)
  | { type: "error"; message: string }
  /** Live activity of the job (see ActivityStep / TokenUsage in claude.ts). */
  | { type: "step"; step: ActivityStep }
  | { type: "thinking_delta"; sid: string; text: string }
  | ({ type: "usage" } & TokenUsage);
export type HandoffEvent = { job: string } & HandoffEventBody;
/** The docs of a pack, in reading order. */
export const DESIGN_DOCS = ["00-overview.md", "01-gdd.md", "02-tech-design.md", "03-roadmap.md", "04-open-questions.md", "05-assets.md", "CLAUDE.md"] as const;

export interface Api {
  /** "tauri" talks to the Rust core; "mock" is an in-memory stand-in for browser dev. */
  kind: "tauri" | "mock";
  workspaceInfo(): Promise<WorkspaceInfo>;
  setWorkspaceRoot(path: string): Promise<WorkspaceInfo>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(name: string): Promise<ProjectSummary>;
  /** `handoff_target: ""` clears the target (and its confirmation). */
  updateProject(slug: string, patch: { name?: string; theme?: string; handoff_target?: string; handoff_target_confirmed?: string }): Promise<ProjectSummary>;
  loadProject(slug: string): Promise<ProjectData>;
  saveCanvas(slug: string, canvas: Canvas): Promise<void>;
  /** Why the workspace opened read-only (a failed layout migration), or null. */
  migrationStatus(): Promise<string | null>;
  createCard(slug: string, card: NewCard): Promise<Card>;
  readCard(slug: string, id: string): Promise<Card>;
  updateCard(slug: string, id: string, patch: CardPatch): Promise<Card>;
  deleteCard(slug: string, id: string): Promise<TrashItem>;
  /** Trash with a custom reason, e.g. "lost to <winner title>" when picking a fork's winner. */
  loseCard(slug: string, id: string, reason: string): Promise<TrashItem>;
  listTrash(slug: string): Promise<TrashItem[]>;
  restoreCard(slug: string, id: string): Promise<Card>;
  emptyTrash(slug: string): Promise<number>;
  /** Saves files under the project's media/ folder; returns their paths in order (e.g. "media/xyz.png"). */
  saveMedia(slug: string, files: MediaUpload[]): Promise<string[]>;
  addAttachment(slug: string, card: string, attachment: NewAttachment): Promise<Card>;
  updateAttachment(slug: string, card: string, attId: string, patch: AttachmentPatch): Promise<Card>;
  /** Removes the record; the media file stays until the Trash is emptied. */
  removeAttachment(slug: string, card: string, attId: string): Promise<Card>;
  /** Listed ids first in that order; unlisted ones keep their order after them. */
  reorderAttachments(slug: string, card: string, ids: string[]): Promise<Card>;
  /** Fetches a page into a new clip (favicon, og:image and a text excerpt saved under media/). Never rejects for network
   *  problems: a failed fetch resolves to a bare clip with `fetch_error`. The caller adds it to a card. */
  fetchClip(slug: string, url: string): Promise<ClipAttachment>;
  /** Deletes a card's pending Claude proposal (after Keep applied it, or on Dismiss). */
  dismissProposal(slug: string, id: string): Promise<void>;
  /** Writes a proposal back (Undo of a dismiss). */
  restoreProposal(slug: string, id: string, proposal: EditProposal): Promise<void>;
  /** Opens an http(s) URL in the default browser. */
  openUrl(url: string): Promise<void>;
  /** Re-fetches a clip in place (same id, caption kept). */
  refreshClip(slug: string, card: string, attId: string): Promise<Card>;
  /** Reads a file back from inside the project (e.g. a media/ path) as a data: URL. */
  readMedia(slug: string, rel: string): Promise<string>;
  /** Files changed on disk (by this app, Claude Code, git...). Returns an unsubscribe function. */
  onChange(cb: (events: ChangeEvent[]) => void): Promise<() => void>;
  /** "Link repo…" confirmed: sets and confirms the folder the design pack is written into. */
  linkRepo(slug: string, path: string): Promise<ProjectSummary>;
  /** .dreamer.md bundles: plan (no writes), apply, undo, and the watched drop folders. */
  parseBundle(text: string, target?: ImportTarget): Promise<ImportPlan>;
  applyBundle(text: string, target?: ImportTarget): Promise<ImportResult>;
  undoBundle(result: ImportResult): Promise<void>;
  scanImports(): Promise<ImportOffer[]>;
  readImport(path: string): Promise<string>;
  archiveImport(path: string): Promise<void>;
  /** Starts the handoff pack generation (one at a time); returns the job id its events carry. */
  handoffStart(slug: string, spec: HandoffSpec): Promise<string>;
  /** Interrupts the running handoff session; nothing it produced is written. */
  handoffCancel(): Promise<void>;
  onHandoffEvent(cb: (e: HandoffEvent) => void): Promise<() => void>;
  /** Shows %LOCALAPPDATA%\Dreamer\logs (sidecar.log) in the file manager. */
  openLogsFolder(): Promise<void>;
  /** Native folder picker; null when cancelled (or unavailable). */
  pickFolder(title?: string): Promise<string | null>;
  /** Keyword search; `project` omitted = every project. Read-only, no Claude involved. */
  searchCards(query: string, project?: string, limit?: number): Promise<SearchHit[]>;
  /** Removes the project folder (Recycle Bin when possible). The last project can't be deleted. */
  deleteProject(slug: string): Promise<DeletedProject>;
  /** thread = a card id, or "project". */
  loadChat(slug: string, thread: string): Promise<ChatThreadFile>;
  saveChat(slug: string, thread: string, data: ChatThreadFile): Promise<void>;
  /** Clears one thread's file and its Claude session. */
  resetChat(slug: string, thread: string): Promise<void>;
  /** Card thread ids with a saved file, most recently written first. */
  listChats(slug: string): Promise<string[]>;
  memoryGet(slug: string): Promise<MemoryView>;
  /** `source` "user" for the modal's Save; "seed" for the seed's Keep / Start empty. */
  memorySave(slug: string, text: string, source: "user" | "seed"): Promise<MemoryView>;
  /** Newest first. */
  memoryHistory(slug: string): Promise<MemoryLogEntry[]>;
  /** Undoes one log entry line by line. */
  memoryRevert(slug: string, at: string): Promise<MemoryView>;
  /** Undo of a chat turn's "Memory updated" line: its log entries, and the decision lines drafted onto a card. */
  memoryUndo(slug: string, ats: string[], card?: string, lines?: string[]): Promise<void>;
  /** Starts the one-time seed query (needs >= 3 kept cards and no memory.md); the draft arrives via onMemoryEvent. */
  memorySeed(slug: string): Promise<void>;
  onMemoryEvent(cb: (e: MemoryEvent) => void): Promise<() => void>;
  artifactCreate(slug: string, artifact: NewArtifact): Promise<Card>;
  artifactGet(slug: string, id: string): Promise<ArtifactView>;
  artifactUpdate(slug: string, id: string, patch: ArtifactPatch): Promise<ArtifactView>;
  /** One file of a version as a data: URL. */
  artifactFile(slug: string, id: string, version: number, file: string): Promise<string>;
  artifactVersionInfo(slug: string, id: string, version: number): Promise<ArtifactVersionInfo>;
  /** null clears the active theme. */
  artifactSetActiveTheme(slug: string, id: string | null): Promise<void>;
  artifactThemes(slug: string): Promise<ArtifactThemeRef[]>;
  /** An HTML version bundled for the sandbox (CSP first, theme tokens, files inlined); `head` = extra <style> (fonts). */
  artifactHtml(slug: string, id: string, version: number, head?: string): Promise<string>;
  spritecookKeyStatus(): Promise<SpritecookKeyStatus>;
  /** Stores the SpriteCook API key in the OS credential store; "" removes it. */
  spritecookSetKey(key: string): Promise<SpritecookKeyStatus>;
}
