import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClaudeApi, ClaudeEvent, ClaudeStatus, SetupEvent } from "./claude";

export const claudeTauriApi: ClaudeApi = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  send: (slug, id, text, context) => invoke("claude_send", { slug, id, text, context }),
  interrupt: () => invoke("claude_interrupt"),
  onEvent: async (cb) => listen<ClaudeEvent>("claude-event", (e) => cb(e.payload)),
  install: () => invoke("claude_install"),
  login: () => invoke("claude_login"),
  cancelSetup: () => invoke("claude_setup_cancel"),
  openLoginUrl: (url) => invoke("claude_open_login_url", { url }),
  onSetupEvent: async (cb) => listen<SetupEvent>("claude-setup", (e) => cb(e.payload)),
};
