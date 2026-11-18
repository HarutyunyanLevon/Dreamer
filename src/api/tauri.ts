import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Api, ChangeEvent, HandoffEvent, MemoryEvent } from "./types";

function mimeFor(rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "ico": return "image/x-icon";
    case "avif": return "image/avif";
    case "md": return "text/markdown";
    default: return "application/octet-stream";
  }
}

/** Thin typed wrapper over the Rust commands (src-tauri/src/commands.rs). */
export const tauriApi: Api = {
  kind: "tauri",
  workspaceInfo: () => invoke("workspace_info"),
  setWorkspaceRoot: (path) => invoke("set_workspace_root", { path }),
  getSettings: () => invoke("get_settings"),
  updateSettings: (patch) => invoke("update_settings", { patch }),
  listProjects: () => invoke("list_projects"),
  createProject: (name) => invoke("create_project", { name }),
  updateProject: (slug, patch) => invoke("update_project", { slug, patch }),
  loadProject: (slug) => invoke("load_project", { slug }),
  saveCanvas: (slug, canvas, folder) => invoke("save_canvas", { slug, canvas, folder: folder ?? null }),
  saveLayout: (slug, layout) => invoke("save_layout", { slug, layout }),
  deleteFolder: (slug, id) => invoke("delete_folder", { slug, id }),
  createCard: (slug, card) => invoke("create_card", { slug, card }),
  readCard: (slug, id) => invoke("read_card", { slug, id }),
  updateCard: (slug, id, patch) => invoke("update_card", { slug, id, patch }),
  deleteCard: (slug, id) => invoke("delete_card", { slug, id }),
  loseCard: (slug, id, reason) => invoke("lose_card", { slug, id, reason }),
  listTrash: (slug) => invoke("list_trash", { slug }),
  restoreCard: (slug, id) => invoke("restore_card", { slug, id }),
  emptyTrash: (slug) => invoke("empty_trash", { slug }),
  saveMedia: (slug, files) => invoke("save_media", { slug, files: files.map((f) => ({ name_hint: f.name_hint, bytes: Array.from(f.bytes) })) }),
  addAttachment: (slug, card, attachment) => invoke("add_attachment", { slug, card, attachment: { id: "", ...attachment } }),
  updateAttachment: (slug, card, attId, patch) => invoke("update_attachment", { slug, card, attId, patch }),
  removeAttachment: (slug, card, attId) => invoke("remove_attachment", { slug, card, attId }),
  reorderAttachments: (slug, card, ids) => invoke("reorder_attachments", { slug, card, ids }),
  fetchClip: (slug, url) => invoke("fetch_clip", { slug, url }),
  dismissProposal: (slug, id) => invoke("dismiss_proposal", { slug, id }),
  restoreProposal: (slug, id, proposal) => invoke("restore_proposal", { slug, id, proposal }),
  refreshClip: (slug, card, attId) => invoke("refresh_clip", { slug, card, attId }),
  openUrl: (url) => invoke("open_url", { url }),
  readMedia: async (slug, rel) => {
    const b64 = await invoke<string>("read_media", { slug, rel });
    return `data:${mimeFor(rel)};base64,${b64}`;
  },
  handoffStart: (slug, mode, spec, gaps) => invoke("handoff_start", { slug, mode, spec, gaps: gaps ?? null }),
  handoffCancel: () => invoke("handoff_cancel"),
  onHandoffEvent: (cb) => listen<HandoffEvent>("handoff-event", (e) => cb(e.payload)),
  listDesignVersions: (slug) => invoke("list_design_versions", { slug }),
  readDesignDoc: (slug, version, name) => invoke("read_design_doc", { slug, version, name }),
  openDesignFolder: (slug, version) => invoke("open_design_folder", { slug, version }),
  openLogsFolder: () => invoke("open_logs_folder"),
  pickFolder: (title) => invoke("pick_folder", { title: title ?? null }),
  searchCards: (query, project, limit) => invoke("search_cards", { query, project: project ?? null, limit: limit ?? null }),
  deleteProject: (slug) => invoke("delete_project", { slug }),
  loadChat: (slug, thread) => invoke("load_chat", { slug, thread }),
  saveChat: (slug, thread, data) => invoke("save_chat", { slug, thread, data }),
  resetChat: (slug, thread) => invoke("reset_chat", { slug, thread }),
  listChats: (slug) => invoke("list_chats", { slug }),
  listCustomThemes: () => invoke("list_custom_themes"),
  saveCustomTheme: (id, theme) => invoke("save_custom_theme", { id, theme }),
  deleteCustomTheme: (id) => invoke("delete_custom_theme", { id }),
  memoryGet: (slug) => invoke("memory_get", { slug }),
  memorySave: (slug, text, source) => invoke("memory_save", { slug, text, source }),
  memoryHistory: (slug) => invoke("memory_history", { slug }),
  memoryRevert: (slug, at) => invoke("memory_revert", { slug, at }),
  memoryUndo: (slug, ats, card, lines) => invoke("memory_undo", { slug, ats, card: card ?? null, lines: lines ?? null }),
  memorySeed: (slug) => invoke("memory_seed", { slug }),
  onMemoryEvent: (cb) => listen<MemoryEvent>("memory-event", (e) => cb(e.payload)),
  spritecookKeyStatus: () => invoke("spritecook_key_status"),
  spritecookSetKey: (key) => invoke("spritecook_set_key", { key }),
  quitApp: () => invoke("quit_app"),
  autostartEnabled: () => invoke("autostart_enabled"),
  setAutostart: (enabled) => invoke("set_autostart", { enabled }),
  hideToTray: () => invoke("hide_to_tray"),
  onTrayNotice: (cb) => listen("tray-notice", () => cb()),
  onChange: async (cb) => {
    const un = await listen<ChangeEvent[]>("workspace-changed", (e) => cb(e.payload));
    return un;
  },
};
