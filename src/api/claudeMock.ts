import type { ClaudeApi, ClaudeEvent, ClaudeStatus, SetupEvent, SetupJob } from "./claude";

/**
 * A scripted stand-in for `npm run dev` in a plain browser, where there is no sidecar to talk to.
 * `?claude=missing` or `?claude=signedout` starts in that setup state, to preview the setup screen.
 */
export function createClaudeMockApi(): ClaudeApi {
  const listeners = new Set<(e: ClaudeEvent) => void>();
  const emit = (e: ClaudeEvent) => listeners.forEach((l) => l(e));
  const setupListeners = new Set<(e: SetupEvent) => void>();
  const emitSetup = (e: SetupEvent) => setupListeners.forEach((l) => l(e));

  const mode = typeof location !== "undefined" ? new URLSearchParams(location.search).get("claude") : null;
  let installed = mode !== "missing";
  let loggedIn = mode !== "missing" && mode !== "signedout";
  let job: SetupJob | null = null;
  let timers: number[] = [];
  const fakePath = String.raw`C:\Users\you\AppData\Roaming\npm\claude.cmd`;

  const runJob = (kind: SetupJob, lines: string[], finish: () => void) => {
    job = kind;
    timers = lines.map((line, i) => window.setTimeout(() => emitSetup({ type: "output", kind, line }), 400 * (i + 1)));
    timers.push(
      window.setTimeout(() => {
        finish();
        job = null;
        emitSetup({ type: "done", kind, ok: true, cancelled: false, message: "" });
      }, 400 * (lines.length + 2)),
    );
  };

  return {
    status: async (): Promise<ClaudeStatus> =>
      installed
        ? { installed, version: "mock", path: fakePath, loggedIn, authMethod: loggedIn ? "claude.ai" : null, job }
        : { installed, error: "Claude Code was not found (mock).", job },
    install: async () => {
      runJob("install", [`> npm install -g @anthropic-ai/claude-code`, "added 3 packages in 2s"], () => (installed = true));
    },
    login: async () => {
      runJob("login", ["> claude auth login", "Opening browser to sign in…"], () => (loggedIn = true));
    },
    cancelSetup: async () => {
      if (!job) return;
      timers.forEach(clearTimeout);
      const kind = job;
      job = null;
      emitSetup({ type: "done", kind, ok: false, cancelled: true, message: kind === "login" ? "Sign-in was cancelled." : "Install was cancelled." });
    },
    openLoginUrl: async (url) => {
      window.open(url, "_blank", "noopener");
    },
    onSetupEvent: async (cb) => {
      setupListeners.add(cb);
      return () => setupListeners.delete(cb);
    },
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
