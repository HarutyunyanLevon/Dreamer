import type { StageId } from "../theme/types";
import type { ActivityStep, TokenUsage } from "./claude";

export interface Link {
  to: string;
  label?: string;
}

export type CardKind = "card" | "sticky" | "label" | "checklist" | "image" | "clip" | "artifact";

export type ArtifactType = "theme" | "character" | "concept" | "mockup";
/** "pixel" (with a pixel size) or "hd". */
export interface ArtMode {
  mode: "pixel" | "hd";
  pixelSize?: number;
}
export interface ThemeSpec {
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
export interface ArtifactSuggestion {
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
  folder?: string | null;
}
/** `themeId: ""` / `artMode: null` clear the override; `approvedVersion: 0` clears the approval. */
export interface ArtifactPatch {
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
/** "tech" = the project's Tech & constraints card; "decisions" = the Project decisions card the
 *  handoff gap interview writes into. At most one live card per role per project. */
export type CardRole = "tech" | "decisions" | "cc-questions";

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** An open question rather than a to-do. */
  question?: boolean;
  answer?: string;
  /** The QUESTIONS.md line it was imported from (cc-questions card); answering writes it back there. */
  source?: string;
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
export type NewAttachment = (Omit<ImageAttachment, "id"> | Omit<ClipAttachment, "id">) & { id?: string };
/** Keys to change; `null` clears an optional key. `id`/`type` are ignored. */
export type AttachmentPatch = Partial<Record<Exclude<keyof ImageAttachment | keyof ClipAttachment, "id" | "type">, string | null>>;

export interface MediaUpload {
  name_hint: string;
  bytes: Uint8Array;
}

/** A card's `build` block: what Claude Code built for it (see docs/status-format.md). */
export type BuildStatus = "queued" | "in-progress" | "built" | "partial" | "blocked";
export interface BuildBlock {
  status?: BuildStatus;
  task?: string;
  commits?: string[];
  files?: string[];
  /** Repo images copied into media/ (`path`), or plain repo paths from a bundle. */
  evidence?: (string | { path: string; repo?: string })[];
  notes?: string;
  built_at?: string;
  /** Hash of the saved content at build time; the card "needs a rebuild" while `dirty`. */
  snapshot_hash?: string;
  dirty?: boolean;
  /** Dragged to "Needs rebuild" on the Build board: dirty until built again or dragged back. */
  dirty_manual?: boolean;
  history?: { at: string; status: string; source: string }[];
}

/** A tool call or thinking block of a build run (the sidecar's step). */
export interface BuildStep {
  sid: string;
  kind: "tool" | "thinking";
  tool?: string;
  label: string;
  status: "running" | "done" | "error";
  detail?: string;
}
/** A permission request of a build run, waiting for Allow once / Allow prefix / Deny. */
export interface BuildAsk {
  req: string;
  tool: string;
  why: string;
  detail: string;
  /** "Allow this command prefix" (Bash only), null when the command is not a plain one. */
  prefix: string | null;
  description?: string | null;
}
/** A finished run (`<project>/builds/<id>.json`). */
export interface BuildSummary {
  id: string;
  slug: string;
  result: "done" | "failed" | "interrupted";
  error: string | null;
  branch: string;
  base: string;
  base_sha: string;
  tasks: string[];
  titles: string[];
  cards: string[];
  started_at: string;
  ended_at: string;
  duration_ms: number;
  stashed: boolean;
  model: string;
  commits: { hash: string; subject: string }[];
  files: string[];
  status: { id: string; title: string; status: string | null; notes: string | null }[];
  /** Cards of the run that STATUS.md says nothing about. */
  missing: { id: string; title: string }[];
  /** What the user did with the branch: "merged (fast-forward)", "deleted", "kept". */
  outcome: string | null;
  live?: false;
}
/** A run in progress. */
export interface BuildLive {
  id: string;
  slug: string;
  branch: string;
  base: string;
  tasks: string[];
  titles: string[];
  cards: string[];
  current: number;
  started_at: string;
  stashed: boolean;
  model: string;
  asks: BuildAsk[];
  live: true;
}
export type BuildRunInfo = BuildSummary | BuildLive;
export type BuildEvent = { run: string } & (
  | { type: "started"; info: BuildLive }
  | { type: "step"; step: BuildStep }
  | { type: "text"; text: string }
  | { type: "usage"; input: number; cacheRead: number; cacheCreate: number; output: number }
  | { type: "ask"; ask: BuildAsk }
  | { type: "ask_done"; req: string; decision: string }
  | { type: "denied"; tool: string; reason: string }
  | { type: "task"; index: number }
  | { type: "done"; summary: BuildSummary }
);
/** One logged event of a run (builds/<id>.jsonl). */
export type BuildLogEvent = { at: string; type: string } & Record<string, unknown>;
/** What one STATUS.md change did (event "build-update"). */
export interface BuildUpdate {
  slug: string;
  built: { id: string; title: string }[];
  partial: { id: string; title: string }[];
  in_progress: { id: string; title: string }[];
  new: { id: string; title: string }[];
  blocked: { id: string; title: string }[];
  warnings: string[];
}

export interface Card {
  id: string;
  title: string;
  kind: CardKind;
  role?: CardRole;
  color?: string;
  /** Checklist kind. */
  items?: ChecklistItem[];
  /** cc-questions card: QUESTIONS.md lines of deleted items, never re-imported. */
  dismissed_sources?: string[];
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
  /** The card it was copied from (a new project version, or Compare's "Apply to"); never changes. */
  origin?: Origin;
  /** The .dreamer.md bundle and ref this card was imported from. */
  import?: { bundle_id: string; ref: string; source: string };
  build?: BuildBlock;
  body: string;
  /** Any other frontmatter keys found in the file are passed through untouched. */
  [extra: string]: unknown;
}

/** A card's lineage: the card it was copied from and that card's version (folder id). */
export interface Origin {
  card: string;
  version: string;
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
  color?: string;
  items?: ChecklistItem[];
  attachments?: Attachment[];
  /** Fork marker: {group, of} (see BranchCompare). */
  branch?: unknown;
  x?: number;
  y?: number;
  /** The folder whose canvas it lands on (absent = the open version, or the root without versions). */
  folder?: string;
  origin?: Origin;
}

/** `role: ""` / `color: ""` clear them. */
export type CardPatch = Partial<Pick<Card, "title" | "body" | "stage" | "tags" | "fields" | "links" | "ghost" | "kind" | "items" | "dismissed_sources" | "attachments">> & {
  role?: CardRole | "";
  color?: string;
};

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
  /** 3 since folders (2 frames); older files load with none of either. */
  version: number;
  viewport: Viewport;
  cards: Record<string, Pos>;
  frames: Record<string, Frame>;
  /** Child folders shown on this canvas. */
  folders: Record<string, Pos>;
}

/** A folder inside a project (folders.json). Its contents live on its own canvas. */
export interface Folder {
  id: string;
  title: string;
  /** Parent folder id; null = the project root. */
  parent: string | null;
  color?: string;
  created: string;
  updated: string;
  nudge_off?: boolean;
  /** "version" = a project version (always top-level); absent = an ordinary folder. */
  kind?: "version";
  /** A version: the version it was copied from. */
  created_from?: string;
  [extra: string]: unknown;
}

/** One saveLayout call: canvases by folder id ("" = the root) and optionally the whole folder list. */
export interface LayoutWrite {
  canvases: Record<string, Canvas>;
  folders?: Folder[];
}

export interface ProjectMeta {
  name: string;
  theme?: string;
  created: string;
  /** Repo folder the handoff pack is copied into. */
  handoff_target?: string;
  /** The target the user confirmed writing into (first use). Copying needs it to equal handoff_target. */
  handoff_target_confirmed?: string;
  /** The root canvas's "Tidy this folder?" hint was dismissed. */
  nudge_off?: boolean;
  /** The project version (folder id) that opens by default. */
  last_version?: string;
}
export interface ProjectSummary {
  slug: string;
  name: string;
  theme: string | null;
  card_count: number;
  is_inbox: boolean;
  /** Handoff pack versions under design/. */
  design_versions?: number;
  /** Unanswered questions in the handoff repo's docs/design/QUESTIONS.md. */
  open_questions?: number;
}
export interface ProjectData {
  slug: string;
  is_inbox: boolean;
  meta: ProjectMeta;
  /** The root canvas. (In the UI's view, the canvas of the folder that is open.) */
  canvas: Canvas;
  folders: Folder[];
  /** Each folder's canvas by folder id. */
  canvases: Record<string, Canvas>;
  cards: Card[];
  /** Pending Claude edit proposals by card id (cards/<id>.proposal.json). */
  proposals?: Record<string, EditProposal>;
  warnings: string[];
  /** The root has top-level folders and no versions yet: ask which ones are versions (once). */
  version_migration?: { folders: { id: string; title: string; suggested: boolean }[] };
}

/** Arrange layouts of an organize plan. */
export type OrganizeLayout = "grid" | "cluster-by-tag" | "flow-by-links" | "stage-columns";
/** One op of an organize plan, as validated by Rust. Folder refs: an id, a tempId made earlier, or null (the root). */
export type OrganizeOp =
  | { op: "create_folder"; tempId: string; title: string; parent: string | null; color?: string }
  | { op: "rename"; id: string; title: string }
  | { op: "move"; ids: string[]; to: string | null; x?: number; y?: number }
  | { op: "create_frame"; tempId: string; folder: string | null; title: string; rect: { x: number; y: number; w: number; h: number } }
  | { op: "arrange"; folder: string | null; ids: string[]; layout: OrganizeLayout }
  /** Explicit positions (the organize pipeline lays cards out itself). */
  | { op: "place"; folder: string | null; positions: Record<string, { x: number; y: number }> }
  | { op: "retag"; id: string; add: string[]; remove: string[] };
/** A propose_organize plan (validated whole; nothing applied until the user does). */
export interface OrganizePlanData {
  slug: string;
  scope: "folder" | "project";
  /** The folder the scope starts at (null = the root). */
  folder: string | null;
  scopeName: string;
  rationale: string;
  ops: OrganizeOp[];
  /** Pinned items the plan leaves where they are. */
  kept: { id: string; title: string }[];
  /** Titles of the existing cards / folders / frames the ops name. */
  titles: Record<string, string>;
  /** A pipeline plan where some cards could not be placed (they are listed in `unplaced`). */
  partial?: boolean;
  unplaced?: { id: string; title: string }[];
  /** The organize pipeline's state (groups, assignments), for "Retry rest locally" / "Finish with Claude". */
  pipeline?: { groups: { id: string; title: string; purpose: string }[]; backend?: string; problems?: string[] } & Record<string, unknown>;
}

export interface ImportTarget {
  project?: string;
  version?: string;
  /** "" = no default frame. */
  frame?: string;
  at?: [number, number];
  open_project?: string;
}
export interface ImportPlan {
  header: { bundle_id: string; title: string; project?: string; version?: string; frame?: string; source: string; created: string };
  project: string;
  version: string | null;
  frame: string | null;
  unresolved: ("project" | "version")[];
  projects: { slug: string; name: string; versions: { id: string; title: string }[]; open_version: string | null }[];
  frames: string[];
  cards: { ref: string; title: string; stage: StageId; action: "new" | "update" | "replace"; card_id: string | null; frame: string | null; has_build: boolean }[];
  warnings: string[];
}
export interface ImportResult {
  project: string;
  folder: string | null;
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
  project: string | null;
}

/** A change Claude proposed for one card (propose_edit). Only the listed keys change. */
export interface EditProposal {
  title?: string;
  body?: string;
  tags?: string[];
  stage?: StageId;
  /** New captions keyed by attachment id. */
  captions?: Record<string, string>;
  /** From an imported bundle: what was built (shown as part of the diff). */
  build?: Record<string, unknown>;
  reason?: string;
  created?: string;
}

export interface Settings {
  version: number;
  theme: string;
  hotkey: string;
  /** Global "Clipboard to Inbox" shortcut. */
  clipboard_hotkey: string;
  last_project: string | null;
  /** Left panel (projects) shown. */
  show_projects: boolean;
  /** Right panel (Claude chat) shown. */
  show_chat: boolean;
  /** Panel widths in px (left 180-420, chat 280-720); absent in the in-memory demo. */
  side_w?: number;
  chat_w?: number;
  /** The one-time "still running in the tray" notice has been seen. */
  tray_notice_shown: boolean;
  /** Launch Dreamer when Windows starts. */
  start_with_windows: boolean;
  /** On a Windows-start launch, stay in the tray without opening the window. */
  start_hidden: boolean;
  /** Claude model for chat sessions (alias like "sonnet" or a full id). */
  model_chat: string;
  /** Route chat turns between the fast / main (model_chat) / deep models. */
  model_router: boolean;
  model_fast: string;
  model_deep: string;
  /** Claude model for the handoff pack sessions (gap check and generation). */
  model_export: string;
  /** Claude model for build runs (Claude Code in the repo); never a local model. */
  build_model: string;
  /** Claude model for thread summaries (auto-compact). */
  model_memory: string;
  /** Summarize a thread into a fresh session once a turn read more input tokens than this. */
  compact_tokens: number;
  /** Word cap of a project's memory.md. */
  memory_cap: number;
  /** Everyday chat turns run on a local model through Ollama (Think, web and Retry with Claude go to Claude). */
  local_chat: boolean;
  /** Ollama model for local turns. */
  local_model: string;
  /** Folder picked with "Locate ollama.exe…" (searched first); "" = none. */
  ollama_path?: string;
  /** The cloud model was declined on a weak-GPU PC: chat stays on Claude. */
  local_cloud_declined?: boolean;
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
export interface SettingsPatch {
  theme?: string;
  hotkey?: string;
  clipboard_hotkey?: string;
  /** Empty string clears it. */
  last_project?: string;
  show_projects?: boolean;
  show_chat?: boolean;
  side_w?: number;
  chat_w?: number;
  tray_notice_shown?: boolean;
  start_with_windows?: boolean;
  start_hidden?: boolean;
  /** Empty string restores the default. */
  model_chat?: string;
  model_router?: boolean;
  model_fast?: string;
  model_deep?: string;
  model_export?: string;
  build_model?: string;
  model_memory?: string;
  /** 0 restores the default. */
  compact_tokens?: number;
  /** 0 restores the default. */
  memory_cap?: number;
  local_chat?: boolean;
  /** Empty string restores the default. */
  local_model?: string;
  ollama_path?: string;
  local_cloud_declined?: boolean;
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

export interface MemoryOp {
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
  /** "folder" for a trashed folder (with its subtree); absent = a card. */
  kind?: "folder";
  /** The folder it was in (absent = the root). */
  folder?: string | null;
  /** A folder: how many cards went with it. */
  count?: number;
}

export interface WorkspaceInfo {
  root: string;
  is_default: boolean;
}

export interface ChangeEvent {
  scope: "project" | "settings" | "themes" | "memory" | "artifact" | "questions";
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
  /** "Folder / Subfolder" when the card is inside a folder. */
  folder_path?: string;
}

export interface DeletedProject {
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
  /** Local-model (Ollama) session to resume for this thread. */
  localSessionId?: string;
  messages: unknown[];
  /** Rust-owned (kept across saves): context snapshot, last input tokens, thread summary. */
  ctx?: unknown;
  last_input_tokens?: number;
  /** The model's context window at the last turn (Rust-owned). */
  context_window?: number;
  summary?: string;
}

// ----- the project handoff pack (src-tauri/src/handoff.rs) -----

export type HandoffScope = { kind: "project" } | { kind: "selection"; ids: string[] } | { kind: "frames"; ids: string[] } | { kind: "card"; id: string } | { kind: "folder"; id: string };
export interface HandoffSpec {
  scope: HandoffScope;
  /** Stages of plain cards to include (other kinds have no stage and are always in). */
  stages: StageId[];
  include_stickies: boolean;
  /** The project version the pack is of (folder id); absent = the one the scope is in, else the open one. */
  version?: string;
}
export type GapStatus = "ok" | "thin" | "missing";
export interface Gap {
  item: string;
  status: GapStatus;
  note: string;
}
/** One entry of design/index.json. */
export interface DesignVersion {
  version: number;
  created: string;
  model: string;
  scope: string;
  docs: string[];
  cards: number;
  /** The project version (folder id) this revision is of; "" without versions. */
  version_id?: string;
  version_title?: string;
  /** Folder under design/ (`design/<dir>/r<N>/`); "" = the flat `design/v<N>/`. */
  dir?: string;
}
export interface HandoffRepoResult {
  path: string;
  files?: string[];
  questions_created?: boolean;
  warnings?: string[];
  /** The version was written but copying into the repo failed. */
  error?: string;
}
export type HandoffEventBody =
  | { type: "progress"; step: "reading"; read: number; total: number; images?: number }
  | { type: "progress"; step: "viewing"; viewed: number; images: number }
  | { type: "progress"; step: "writing"; doc: string; written: number; of: number }
  | { type: "progress"; step: "copying" }
  | { type: "note"; step: string; note: string }
  | { type: "gaps"; gaps: Gap[] }
  | { type: "done"; mode: "gaps" }
  | { type: "done"; mode: "task"; markdown: string; title: string; card_ids: string[]; flags: TaskFlag[]; model: string; version: string; kind: TaskKind }
  | { type: "done"; mode: "generate"; version: number; label?: string; design_dir?: string; dir: string; warnings: string[]; repo: HandoffRepoResult | null }
  | { type: "error"; message: string }
  /** Live activity of the job (see ActivityStep / TokenUsage in claude.ts). */
  | { type: "step"; step: ActivityStep }
  | { type: "thinking_delta"; sid: string; text: string }
  | ({ type: "usage" } & TokenUsage);
export type HandoffEvent = { job: string } & HandoffEventBody;
/** "Make build prompt": a thin spot Claude found while writing the task. */
export interface TaskFlag {
  card_id?: string | null;
  text: string;
}
export type TaskKind = "build" | "rebuild";
export interface TaskSave {
  markdown: string;
  title: string;
  card_ids: string[];
  kind: TaskKind;
  version: string;
}
/** A saved task file (<repo>/docs/design/tasks/). */
export interface SavedTask {
  /** Repo-relative path. */
  file: string;
  title: string;
  id: string;
  kind: string;
  cards: string[];
  created: string;
  version: string;
  done?: string | null;
}
/** What Claude Code is told to do with a saved task (mirrors task::reference). */
export const taskReference = (file: string) => `Implement ${file}. Follow CLAUDE.md and the Report back section.`;
/** The docs of a version, in reading order (CHANGELOG last). */
export const DESIGN_DOCS = ["00-overview.md", "01-gdd.md", "02-tech-design.md", "03-roadmap.md", "04-open-questions.md", "05-assets.md", "CLAUDE.md", "CHANGELOG.md"] as const;
/** The gap check's checklist (mirrors CHECKLIST in handoff.rs). */
export const GAP_CHECKLIST = [
  "core experience/feeling", "target player", "core loop", "key mechanics", "progression", "setting & tone", "art direction",
  "audio direction", "platform & tech", "scope & time budget", "monetization", "what makes it different", "top risks",
] as const;
export const TECH_GAP_ITEM = "platform & tech";

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
  updateProject(slug: string, patch: { name?: string; theme?: string; handoff_target?: string; handoff_target_confirmed?: string; nudge_off?: boolean; last_version?: string }): Promise<ProjectSummary>;
  loadProject(slug: string): Promise<ProjectData>;
  /** The one-time "Treat these folders as versions?" answer (ids of the folders that become versions). */
  migrateVersions(slug: string, versions: string[]): Promise<boolean>;
  /** "New version from <from>": copies the version whole (new ids, origin set) and makes it the open one. */
  newVersion(slug: string, from: string, title: string): Promise<{ version: Folder; cards: Record<string, string> }>;
  /** `folder` omitted/null = the root canvas. */
  saveCanvas(slug: string, canvas: Canvas, folder?: string | null): Promise<void>;
  /** Several canvases and the folder list in one write (moves between folders, folder edits). */
  saveLayout(slug: string, layout: LayoutWrite): Promise<void>;
  /** A folder and everything below it go to Trash as one item. */
  deleteFolder(slug: string, id: string): Promise<TrashItem>;
  createCard(slug: string, card: NewCard): Promise<Card>;
  readCard(slug: string, id: string): Promise<Card>;
  updateCard(slug: string, id: string, patch: CardPatch): Promise<Card>;
  deleteCard(slug: string, id: string): Promise<TrashItem>;
  /** Trash with a custom reason, e.g. "lost to <winner title>" when picking a fork's winner. */
  loseCard(slug: string, id: string, reason: string): Promise<TrashItem>;
  listTrash(slug: string): Promise<TrashItem[]>;
  /** Restores a trashed card, or a trashed folder (then it resolves to `{ folder: id }`). */
  restoreCard(slug: string, id: string): Promise<Card | { folder: string }>;
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
  /** STATUS.md in the project's repo changed and was applied. */
  onBuildUpdate(cb: (u: BuildUpdate) => void): Promise<() => void>;
  /** "Link repo…" confirmed: sets and confirms the folder, creates STATUS.md, optionally git-ignores `.dreamer/`, writes link.json. */
  linkRepo(slug: string, path: string, gitignore: boolean): Promise<ProjectSummary>;
  /** "Mark as built now" / "Clear needs rebuild": the saved content becomes the snapshot. */
  markBuiltNow(slug: string, id: string): Promise<Card>;
  /** Undo of the above. */
  restoreBuild(slug: string, id: string, build: BuildBlock | null, snapshot: string | null, stage: StageId): Promise<Card>;
  /** The card's content at build time (null: no snapshot) and now, for "Diff since built". */
  buildTexts(slug: string, id: string): Promise<{ snapshot: string | null; current: string }>;
  /** Opens a repo-relative file in VS Code (`code` on PATH) or shows it in the file manager. */
  openRepoFile(slug: string, rel: string, reveal: boolean): Promise<void>;
  /** Quit for real: stops the Claude sidecar (and everything it started), then exits. */
  quitApp(): Promise<void>;
  /** Real state of the Windows Run entry. */
  autostartEnabled(): Promise<boolean>;
  /** Enables/disables the Run entry; resolves to the real state afterwards. */
  setAutostart(enabled: boolean): Promise<boolean>;
  /** Hide the main window to the tray and remember the tray notice was seen. */
  hideToTray(): Promise<void>;
  /** .dreamer.md bundles: plan (no writes), apply, undo, and the watched drop folders. */
  parseBundle(text: string, target?: ImportTarget): Promise<ImportPlan>;
  applyBundle(text: string, target?: ImportTarget): Promise<ImportResult>;
  undoBundle(result: ImportResult): Promise<void>;
  scanImports(): Promise<ImportOffer[]>;
  /** Scan the linked repo (or one folder of it) for built features; the bundle arrives as a scan event. */
  scanStart(slug: string, folder: string | null, max: number, model: string | null): Promise<string>;
  scanCancel(): Promise<void>;
  onScanEvent(cb: (e: ScanEvent) => void): Promise<() => void>;
  skillStatus(): Promise<SkillStatus>;
  skillInstall(): Promise<SkillStatus>;
  skillRemove(): Promise<SkillStatus>;
  readImport(path: string): Promise<string>;
  archiveImport(path: string): Promise<void>;
  /** Why each global shortcut failed to register: [quick capture, clipboard to Inbox]. */
  hotkeyStatus(): Promise<[string | null, string | null]>;
  /** Split long text into cards on the local model (invented cards are dropped). */
  splitText(text: string): Promise<{ cards: { title: string; body: string; tags: string[] }[]; warnings: string[] }>;
  /** The main window's X was clicked for the first time: show the one-time tray notice. */
  onTrayNotice(cb: () => void): Promise<() => void>;
  /** Starts the handoff gap check or generation (one at a time); returns the job id its events carry. */
  handoffStart(slug: string, mode: "gaps" | "generate", spec: HandoffSpec, gaps?: Gap[]): Promise<string>;
  /** Interrupts the running handoff session; nothing it produced is written. */
  handoffCancel(): Promise<void>;
  /** "Make build prompt" for these cards (their links come along as context); events like handoffStart's. */
  taskStart(slug: string, ids: string[]): Promise<string>;
  /** Writes the task into the linked repo and queues its cards; returns the repo-relative path. */
  saveTask(slug: string, task: TaskSave): Promise<string>;
  listTasks(slug: string): Promise<SavedTask[]>;
  markTaskDone(slug: string, file: string): Promise<void>;
  /** `claude "<reference>"` in a terminal in the repo; rejects when `claude` is not on PATH. */
  openTerminal(slug: string, file: string): Promise<void>;
  onHandoffEvent(cb: (e: HandoffEvent) => void): Promise<() => void>;
  /** Before a run: the repo's branch and whether it has uncommitted changes (rejects when it is not a git repo). */
  buildPreflight(slug: string): Promise<{ repo: string; branch: string; dirty: boolean; busy: boolean }>;
  /** Runs saved tasks one after another on one new branch. `dirty`: "stash" | "continue" for a dirty tree. */
  buildStart(slug: string, tasks: string[], dirty: "stash" | "continue" | "clean"): Promise<BuildLive>;
  buildInterrupt(run: string): Promise<void>;
  buildAnswer(run: string, req: string, decision: "once" | "prefix" | "deny", reason?: string): Promise<void>;
  /** Live runs first, then past runs, newest first. */
  buildRuns(slug: string): Promise<BuildRunInfo[]>;
  buildEvents(slug: string, run: string): Promise<BuildLogEvent[]>;
  buildFileDiff(slug: string, run: string, file: string): Promise<string>;
  /** Merge (into the base, never pushed), delete or keep the run's branch; returns the updated summary. */
  buildAct(slug: string, run: string, action: "merge" | "delete" | "keep"): Promise<BuildSummary>;
  buildOpenTerminal(slug: string): Promise<void>;
  onBuildEvent(cb: (e: BuildEvent) => void): Promise<() => void>;
  listDesignVersions(slug: string): Promise<DesignVersion[]>;
  /** `dir`: the version's folder under design/ ("" / absent = the flat layout). */
  readDesignDoc(slug: string, version: number, name: string, dir?: string): Promise<string>;
  openDesignFolder(slug: string, version: number, dir?: string): Promise<void>;
  /** Shows %LOCALAPPDATA%\Dreamer\logs (sidecar.log) in the file manager. */
  openLogsFolder(): Promise<void>;
  /** Native folder picker; null when cancelled (or unavailable). */
  pickFolder(title?: string): Promise<string | null>;
  /** Keyword search; `project` omitted = every project. Read-only, no Claude involved. */
  searchCards(query: string, project?: string, limit?: number): Promise<SearchHit[]>;
  /** Removes the project folder (Recycle Bin when possible). The Inbox can't be deleted. */
  deleteProject(slug: string): Promise<DeletedProject>;
  /** thread = a card id, or "project". */
  loadChat(slug: string, thread: string): Promise<ChatThreadFile>;
  saveChat(slug: string, thread: string, data: ChatThreadFile): Promise<void>;
  /** Clears one thread's file and its Claude session. */
  resetChat(slug: string, thread: string): Promise<void>;
  /** Card thread ids with a saved file, most recently written first. */
  listChats(slug: string): Promise<string[]>;
  listCustomThemes(): Promise<unknown[]>;
  saveCustomTheme(id: string, theme: unknown): Promise<void>;
  deleteCustomTheme(id: string): Promise<void>;
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

/** Repo scan (scan_start): events on "scan-event". `bundle` arrives before `done`. */
export type ScanEvent = { job: string } & (
  | { type: "progress"; note: string }
  | { type: "step"; label: string }
  | { type: "bundle"; bundle: string }
  | { type: "done" }
  | { type: "error"; message: string }
);

/** The Claude Code card skill (dreamer-cards) in %USERPROFILE%\.claude\skills. */
export interface SkillStatus {
  /** edited: differs from every version Dreamer shipped, so it is never replaced silently. */
  state: "missing" | "current" | "outdated" | "edited";
  path: string;
}
