import type { StageId } from "../theme/types";
import type { ActivityStep, TokenUsage } from "./claude";

export interface Link {
  to: string;
  label?: string;
}

export type CardKind = "card" | "sticky" | "label" | "checklist" | "image" | "clip";
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

export interface Card {
  id: string;
  title: string;
  kind: CardKind;
  role?: CardRole;
  color?: string;
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
  color?: string;
  items?: ChecklistItem[];
  attachments?: Attachment[];
  /** Fork marker: {group, of} (see BranchCompare). */
  branch?: unknown;
  x?: number;
  y?: number;
  /** The folder whose canvas it lands on (absent = the project root). */
  folder?: string;
}

/** `role: ""` / `color: ""` clear them. */
export type CardPatch = Partial<Pick<Card, "title" | "body" | "stage" | "tags" | "fields" | "links" | "ghost" | "kind" | "items" | "attachments">> & {
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
  hotkey: string;
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
  model_memory?: string;
  /** 0 restores the default. */
  compact_tokens?: number;
  /** 0 restores the default. */
  memory_cap?: number;
  local_chat?: boolean;
  /** Empty string restores the default. */
  local_model?: string;
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
  scope: "project" | "settings" | "themes" | "memory";
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
  | { type: "done"; mode: "generate"; version: number; dir: string; warnings: string[]; repo: HandoffRepoResult | null }
  | { type: "error"; message: string }
  /** Live activity of the job (see ActivityStep / TokenUsage in claude.ts). */
  | { type: "step"; step: ActivityStep }
  | { type: "thinking_delta"; sid: string; text: string }
  | ({ type: "usage" } & TokenUsage);
export type HandoffEvent = { job: string } & HandoffEventBody;
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
  updateProject(slug: string, patch: { name?: string; theme?: string; handoff_target?: string; handoff_target_confirmed?: string; nudge_off?: boolean }): Promise<ProjectSummary>;
  loadProject(slug: string): Promise<ProjectData>;
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
  /** Quit for real: stops the Claude sidecar (and everything it started), then exits. */
  quitApp(): Promise<void>;
  /** Real state of the Windows Run entry. */
  autostartEnabled(): Promise<boolean>;
  /** Enables/disables the Run entry; resolves to the real state afterwards. */
  setAutostart(enabled: boolean): Promise<boolean>;
  /** Hide the main window to the tray and remember the tray notice was seen. */
  hideToTray(): Promise<void>;
  /** The main window's X was clicked for the first time: show the one-time tray notice. */
  onTrayNotice(cb: () => void): Promise<() => void>;
  /** Starts the handoff gap check or generation (one at a time); returns the job id its events carry. */
  handoffStart(slug: string, mode: "gaps" | "generate", spec: HandoffSpec, gaps?: Gap[]): Promise<string>;
  /** Interrupts the running handoff session; nothing it produced is written. */
  handoffCancel(): Promise<void>;
  onHandoffEvent(cb: (e: HandoffEvent) => void): Promise<() => void>;
  listDesignVersions(slug: string): Promise<DesignVersion[]>;
  readDesignDoc(slug: string, version: number, name: string): Promise<string>;
  openDesignFolder(slug: string, version: number): Promise<void>;
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
  spritecookKeyStatus(): Promise<SpritecookKeyStatus>;
  /** Stores the SpriteCook API key in the OS credential store; "" removes it. */
  spritecookSetKey(key: string): Promise<SpritecookKeyStatus>;
}
