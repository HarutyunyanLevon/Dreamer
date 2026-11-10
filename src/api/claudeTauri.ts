import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClaudeApi, ClaudeEvent, ClaudeStatus } from "./claude";

export const claudeTauriApi: ClaudeApi = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  send: (slug, id, text, context) => invoke("claude_send", { slug, id, text, context }),
  interrupt: () => invoke("claude_interrupt"),
  onEvent: async (cb) => listen<ClaudeEvent>("claude-event", (e) => cb(e.payload)),
};
