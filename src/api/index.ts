import { createMockApi } from "./mock";
import { tauriApi } from "./tauri";
import type { Api } from "./types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The app talks to the Rust core inside Tauri, and to an in-memory mock in a plain browser. */
export const api: Api = inTauri ? tauriApi : createMockApi();
export * from "./types";
