import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClaudeApi, ClaudeEvent, ClaudeStatus, LocalStatus, OllamaSetupEvent, SetupEvent } from "./claude";

export const claudeTauriApi: ClaudeApi = {
  status: () => invoke<ClaudeStatus>("claude_status"),
  send: (slug, id, text, context, thread, resume, opts) =>
    invoke("claude_send", { slug, id, text, context, thread: thread ?? null, resume: resume ?? null, web: opts?.web ?? false, selection: opts?.selection ?? [], folder: opts?.folder ?? null, memory: opts?.memory ?? true, question: opts?.question ?? null, think: opts?.think ?? false, pin: opts?.pin ?? null, resumeLocal: opts?.resumeLocal ?? null, escalate: opts?.escalate ?? null, organize: opts?.organize ?? null, organizeBackend: opts?.organizeBackend ?? null, artifact: opts?.artifact ?? null, recapFrom: opts?.recapFrom ?? null }),
  interrupt: (opts) => invoke("claude_interrupt", { hard: opts?.hard ?? false }),
  onEvent: async (cb) => listen<ClaudeEvent>("claude-event", (e) => cb(e.payload)),
  install: () => invoke("claude_install"),
  login: () => invoke("claude_login"),
  cancelSetup: () => invoke("claude_setup_cancel"),
  openLoginUrl: (url) => invoke("claude_open_login_url", { url }),
  onSetupEvent: async (cb) => listen<SetupEvent>("claude-setup", (e) => cb(e.payload)),
  localStatus: () => invoke<LocalStatus>("ollama_status"),
  pullLocal: () => invoke("ollama_pull"),
  cancelPullLocal: () => invoke("ollama_cancel"),
  openOllamaInstaller: () => invoke("ollama_open_installer"),
  onLocalSetupEvent: async (cb) => listen<OllamaSetupEvent>("ollama-setup", (e) => cb(e.payload)),
};
