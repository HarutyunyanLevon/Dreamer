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

export type ClaudeEvent =
  | { type: "delta"; id: string; text: string }
  | { type: "question"; id: string; question: string; choices: string[] }
  | { type: "message_done"; id: string; text: string; sessionId?: string; isError?: boolean }
  | { type: "error"; id: string | null; message: string }
  | { type: "stderr"; message: string }
  | { type: "ready" };

export interface ClaudeApi {
  status(): Promise<ClaudeStatus>;
  /** `context` is pre-formatted text (e.g. the selected card's title/body) prepended server-side. */
  send(slug: string, id: string, text: string, context?: string): Promise<void>;
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
