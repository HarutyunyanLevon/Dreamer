import type { ArtifactType, OrganizePlanData, OrganizeScope } from "./types";

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

/** One thing Claude did during a turn: a tool call or a thinking block (built by the sidecar). */
export interface ActivityStep {
  sid: string;
  kind: "tool" | "thinking";
  tool?: string;
  label: string;
  status: "running" | "done" | "error";
  /** ms since the epoch */
  startedAt: number;
  endedAt?: number;
  /** An error's message. */
  detail?: string;
  /** Streamed thinking text (thinking steps; kept up to 2,000 chars in the thread file). */
  text?: string;
  /** Which model call of the turn (1-based) this step came from. */
  call?: number;
}

/** Tokens of a turn, summed over its API calls. */
export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
  /** Each model call's own counts, in order (a turn with tools makes several). */
  calls?: Omit<TokenUsage, "calls">[];
}

/** The router's tiers: fast (simple actions), main (the chat model), deep (Think). */
export type ModelTier = "fast" | "main" | "deep";

/** How a turn ended (diagnostics; the UI keys off isError / fallback). */
type EndReason = "done" | "empty" | "error" | "stalled" | "limit" | "partial";

export type ClaudeEvent =
  | { type: "delta"; id: string; text: string }
  | { type: "step"; id: string; step: ActivityStep }
  | { type: "thinking_delta"; id: string; sid: string; text: string }
  /** `phase: "compact"`: the thread summary that runs before the turn. */
  | ({ type: "usage"; id: string; phase?: "compact" } & TokenUsage)
  /** The memory pass after turn `id` is running (`active`) or ended; input/output tokens so far. */
  | { type: "memory_progress"; id: string; active: boolean; input: number; output: number }
  /** A question form (ask_questions; ask_question is a form of one). `itemId`: only in a checklist grill. */
  | { type: "questions"; id: string; turnId?: string | null; questions: { id: string; question: string; choices: string[]; recommended?: string; context?: string; itemId?: string }[] }
  | { type: "message_done"; id: string; text: string; sessionId?: string; isError?: boolean; inputTokens?: number; usage?: TokenUsage; durationMs?: number; contextTokens?: number; contextWindow?: number; model?: string; tier?: ModelTier; retried?: boolean; retriedFrom?: string; endReason?: EndReason; artifact?: { id: string; credits: number; paidCalls: number; jobs: string[]; spritecook: boolean } }
  /** Sent before a turn starts: the model it runs on. */
  | { type: "route"; id: string; model: string }
  /** A fast-model turn failed or came back empty and was sent again on the main model. */
  | { type: "model_note"; id: string; model: string; retried?: boolean; from?: string }
  /** The sidecar is alive and still on turn `id` (a heartbeat every ~10 s; not model activity). */
  | { type: "alive"; id: string; phase?: string; idleMs?: number }
  /** The sidecar ended turn `id` without an answer (Stop, superseded, reset): nothing more comes for it. */
  | { type: "turn_ended"; id: string; reason: string }
  /** The thread was summarized before turn `id` and continues in a fresh session. */
  | { type: "compacted"; id: string; summary: string }
  | { type: "error"; id: string | null; message: string; endReason?: EndReason }
  | { type: "search"; id: string; query: string; results: SearchResultRef[] }
  | { type: "link_proposal"; id: string | null; slug: string; from: string; to: string; label?: string; reason?: string }
  | { type: "edit_proposal"; id: string | null; slug: string; card: string; title: string }
  | { type: "organize_proposal"; id: string | null; plan: OrganizePlanData }
  | { type: "web_fetch"; id: string; url: string }
  /** An artifact turn wants to go over the per-turn cap of paid SpriteCook calls: it waits for creditAnswer. */
  | { type: "credit_confirm"; id: string | null; reqId: string; tool: string; used: number; cap: number; more: number; estCredits: number | null }
  | { type: "credit_answered"; id: string | null; reqId: string; allow: boolean }
  /** A SpriteCook step of artifact turn `id` started or reported (progress 0..1 when known). */
  | { type: "artifact_progress"; id: string | null; artifact: string | null; label: string; progress: number | null; credits: number }
  | { type: "spritecook_balance"; credits: number | null; tier?: string | null; error: string | null }
  /** A chat turn handed an artifact request to Claude (escalate_artifact): the app creates the card and sends it. */
  | { type: "artifact_escalate"; id: string | null; artifactType: ArtifactType; brief: string; title?: string }
  /** An artifact session started: can SpriteCook make images? `reason`: "no_key" | "unreachable". */
  | { type: "spritecook_status"; id: string | null; artifact: string | null; ok: boolean; reason: "no_key" | "unreachable" | null; missing: string[] }
  /** The memory pass (or remember/forget) changed memory after turn `id`; `ats` = its log entries, `card` = decisions drafted onto the card. */
  | { type: "memory_update"; id: string; label: string; ats: string[]; card?: { id: string; title: string; lines: string[] } | null }
  | { type: "stderr"; message: string }
  /** The sidecar process ended (crash, kill, broken pipe) or the app restarted it (`restarted`).
   *  Every reply still streaming has failed, except `keep` (being resent to a fresh sidecar). */
  | { type: "sidecar_exit"; code: number | null; lastStderr: string[]; ids: string[]; keep?: string | null; restarted?: boolean }
  | { type: "ready" };

export interface ClaudeApi {
  status(): Promise<ClaudeStatus>;
  /** `context` is pre-formatted text (e.g. the selected card's title/body) prepended server-side. */
  /** `thread` = card id or "project"; `resume` = that thread's saved Claude session id. */
  /** `web` = this turn may use WebSearch/WebFetch; `selection` = card ids selected on the canvas. */
  send(slug: string, id: string, text: string, context?: string, thread?: string, resume?: string, opts?: { web?: boolean; selection?: string[]; memory?: boolean; question?: string; think?: boolean; pin?: ModelTier | null; organize?: OrganizeScope; scopeIds?: string[] | null; scopeName?: string | null; organizeInstruction?: string | null; organizePrior?: OrganizePlanData | null; organizeRest?: boolean; artifact?: string | null; recapFrom?: string | null }): Promise<void>;
  /** `memory: false` skips the memory pass after this turn (fixed chip commands); `question` = the question this text answers. */
  /** `hard`: also close the thread's Claude session (Retry after a stall); the next message resumes it. */
  interrupt(opts?: { hard?: boolean }): Promise<void>;
  onEvent(cb: (event: ClaudeEvent) => void): Promise<() => void>;
  /** Runs `npm install -g @anthropic-ai/claude-code`; progress arrives via onSetupEvent. */
  install(): Promise<void>;
  /** Runs `claude auth login` (browser OAuth); progress arrives via onSetupEvent. */
  login(): Promise<void>;
  cancelSetup(): Promise<void>;
  /** Opens a sign-in URL printed by `claude auth login` (Anthropic hosts only). */
  openLoginUrl(url: string): Promise<void>;
  onSetupEvent(cb: (event: SetupEvent) => void): Promise<() => void>;
  /** Answers a paused artifact turn's "Generate N more?" (credit_confirm). */
  creditAnswer(reqId: string, allow: boolean): Promise<void>;
  /** Asks for the SpriteCook credit balance; it arrives as a spritecook_balance event. */
  spritecookBalance(): Promise<void>;
}
