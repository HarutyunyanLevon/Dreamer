import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Api, ChangeEvent } from "./types";

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
  listTrash: (slug) => invoke("list_trash", { slug }),
  restoreCard: (slug, id) => invoke("restore_card", { slug, id }),
  emptyTrash: (slug) => invoke("empty_trash", { slug }),
  onChange: async (cb) => {
    const un = await listen<ChangeEvent[]>("workspace-changed", (e) => cb(e.payload));
    return un;
  },
};
