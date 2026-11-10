export interface ClaudeStatus {
  installed: boolean;
  version?: string;
}

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
}
