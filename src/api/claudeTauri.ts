import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClaudeApi, ClaudeEvent, ClaudeStatus, SetupEvent } from "./claude";

export const claudeTauriApi: ClaudeApi = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  send: (slug, id, text, context, thread, resume, opts) =>
    invoke("claude_send", { slug, id, text, context, thread: thread ?? null, resume: resume ?? null, web: opts?.web ?? false, selection: opts?.selection ?? [], scopeIds: opts?.scopeIds ?? null, scopeName: opts?.scopeName ?? null, memory: opts?.memory ?? true, question: opts?.question ?? null, think: opts?.think ?? false, pin: opts?.pin ?? null, organize: opts?.organize ?? null, organizeInstruction: opts?.organizeInstruction ?? null, organizePrior: opts?.organizePrior ?? null, organizeRest: opts?.organizeRest ?? false, artifact: opts?.artifact ?? null, recapFrom: opts?.recapFrom ?? null }),
  interrupt: (opts) => invoke("claude_interrupt", { hard: opts?.hard ?? false }),
  onEvent: async (cb) => listen<ClaudeEvent>("claude-event", (e) => cb(e.payload)),
  install: () => invoke("claude_install"),
  login: () => invoke("claude_login"),
  cancelSetup: () => invoke("claude_setup_cancel"),
  openLoginUrl: (url) => invoke("claude_open_login_url", { url }),
  onSetupEvent: async (cb) => listen<SetupEvent>("claude-setup", (e) => cb(e.payload)),
  creditAnswer: (reqId, allow) => invoke("claude_credit_answer", { reqId, allow }),
  spritecookBalance: () => invoke("spritecook_balance"),
};
