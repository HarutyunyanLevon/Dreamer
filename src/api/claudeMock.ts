import type { ClaudeApi, ClaudeEvent } from "./claude";

/** A scripted stand-in for `npm run dev` in a plain browser, where there is no sidecar to talk to. */
export function createClaudeMockApi(): ClaudeApi {
  const listeners = new Set<(e: ClaudeEvent) => void>();
  const emit = (e: ClaudeEvent) => listeners.forEach((l) => l(e));

  return {
    status: async () => ({ installed: true, version: "mock" }),
    send: async (_slug, id, text) => {
      const reply = /\/grill-me/i.test(text)
        ? null
        : "I'm a stand-in for Claude in browser preview — the real conversation runs through the Node sidecar inside the Tauri app.";
      setTimeout(() => {
        if (/\/grill-me/i.test(text)) {
          emit({ type: "question", id, question: "What's the one feeling this idea should give a player in its first minute?", choices: ["Awe", "Tension", "Mischief", "Cozy calm"] });
          emit({ type: "message_done", id, text: "" });
          return;
        }
        const words = reply!.split(" ");
        let i = 0;
        const tick = () => {
          if (i >= words.length) {
            emit({ type: "message_done", id, text: reply! });
            return;
          }
          emit({ type: "delta", id, text: (i === 0 ? "" : " ") + words[i] });
          i++;
          setTimeout(tick, 18);
        };
        tick();
      }, 200);
    },
    interrupt: async () => {},
    onEvent: async (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
