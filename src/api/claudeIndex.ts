import { claudeTauriApi } from "./claudeTauri";
import { createClaudeMockApi } from "./claudeMock";
import type { ClaudeApi } from "./claude";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const claudeApi: ClaudeApi = inTauri ? claudeTauriApi : createClaudeMockApi();
export * from "./claude";
