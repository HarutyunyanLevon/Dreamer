export type SetupJob = "install" | "login";

export interface ClaudeStatus {
  installed: boolean;
  version?: string | null;
  /** Full path of the `claude` executable that was found. */
  path?: string | null;
  /** null/undefined = couldn't tell (treated as "let the chat try"). */
  loggedIn?: boolean | null;
  authMethod?: string | null;
  /** Human-readable reason when something is missing or broken. */
  error?: string | null;
  /** A setup job currently running in the backend. */
  job?: SetupJob | null;
}

export type SetupEvent =
  | { type: "output"; kind: SetupJob; line: string }
  | { type: "url"; kind: SetupJob; url: string }
  | { type: "done"; kind: SetupJob; ok: boolean; cancelled: boolean; message: string };

/** A search_cards result as shown in chat (a chip that focuses the card). */
export interface SearchResultRef {
  id: string;
  title: string;
  project: string;
  projectName: string;
  stage: string;
  ghost: boolean;
}

export type ClaudeEvent =
  | { type: "delta"; id: string; text: string }
  | { type: "question"; id: string; question: string; choices: string[] }
  | { type: "message_done"; id: string; text: string; sessionId?: string; isError?: boolean }
  | { type: "error"; id: string | null; message: string }
  | { type: "search"; id: string; query: string; results: SearchResultRef[] }
  | { type: "link_proposal"; id: string | null; slug: string; from: string; to: string; label?: string; reason?: string }
  | { type: "stderr"; message: string }
  | { type: "ready" };

export interface ClaudeApi {
  status(): Promise<ClaudeStatus>;
  /** `context` is pre-formatted text (e.g. the selected card's title/body) prepended server-side. */
  /** `thread` = card id or "project"; `resume` = that thread's saved Claude session id. */
  send(slug: string, id: string, text: string, context?: string, thread?: string, resume?: string): Promise<void>;
  interrupt(): Promise<void>;
  onEvent(cb: (event: ClaudeEvent) => void): Promise<() => void>;
  /** Runs `npm install -g @anthropic-ai/claude-code`; progress arrives via onSetupEvent. */
  install(): Promise<void>;
  /** Runs `claude auth login` (browser OAuth); progress arrives via onSetupEvent. */
  login(): Promise<void>;
  cancelSetup(): Promise<void>;
  /** Opens a sign-in URL printed by `claude auth login` (Anthropic hosts only). */
  openLoginUrl(url: string): Promise<void>;
  onSetupEvent(cb: (event: SetupEvent) => void): Promise<() => void>;
}
