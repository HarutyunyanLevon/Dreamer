import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Api, ChangeEvent } from "./types";

function mimeFor(rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
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
  saveCanvas: (slug, canvas) => invoke("save_canvas", { slug, canvas }),
  createCard: (slug, card) => invoke("create_card", { slug, card }),
  readCard: (slug, id) => invoke("read_card", { slug, id }),
  updateCard: (slug, id, patch) => invoke("update_card", { slug, id, patch }),
  deleteCard: (slug, id) => invoke("delete_card", { slug, id }),
  loseCard: (slug, id, reason) => invoke("lose_card", { slug, id, reason }),
  listTrash: (slug) => invoke("list_trash", { slug }),
  restoreCard: (slug, id) => invoke("restore_card", { slug, id }),
  emptyTrash: (slug) => invoke("empty_trash", { slug }),
  saveMedia: (slug, nameHint, bytes) => invoke("save_media", { slug, nameHint, bytes: Array.from(bytes) }),
  readMedia: async (slug, rel) => {
    const b64 = await invoke<string>("read_media", { slug, rel });
    return `data:${mimeFor(rel)};base64,${b64}`;
  },
  exportBrief: (slug, id) => invoke("export_brief", { slug, id }),
  searchCards: (query, project, limit) => invoke("search_cards", { query, project: project ?? null, limit: limit ?? null }),
  listCustomThemes: () => invoke("list_custom_themes"),
  saveCustomTheme: (id, theme) => invoke("save_custom_theme", { id, theme }),
  deleteCustomTheme: (id) => invoke("delete_custom_theme", { id }),
  onChange: async (cb) => {
    const un = await listen<ChangeEvent[]>("workspace-changed", (e) => cb(e.payload));
    return un;
  },
};
