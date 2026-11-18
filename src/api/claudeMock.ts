import type { ActivityStep, ClaudeApi, ClaudeEvent, ClaudeStatus, LocalStatus, OllamaSetupEvent, SetupEvent, SetupJob } from "./claude";

/**
 * A scripted stand-in for `npm run dev` in a plain browser, where there is no sidecar to talk to.
 * `?claude=missing` or `?claude=signedout` starts in that setup state, to preview the setup screen.
 * `?ollama=missing` / `?ollama=stopped` / `?ollama=nomodel` preview the local-model setup states (default: ready).
 * A message containing "fail" fails on the local model (shows "Retry with Claude").
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
  let turnTimers: number[] = [];
  const localListeners = new Set<(e: OllamaSetupEvent) => void>();
  const ollamaMode = typeof location !== "undefined" ? new URLSearchParams(location.search).get("ollama") : null;
  let ollama: "missing" | "stopped" | "nomodel" | "ready" = ollamaMode === "missing" || ollamaMode === "stopped" || ollamaMode === "nomodel" ? ollamaMode : "ready";
  let pullTimers: number[] = [];
  const localModel = "qwen3.5:35b-a3b";
  const stalledOnce = new Set<string>();

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
    // A scripted turn with fake steps, thinking and token usage, so the live activity view can be
    // checked in the browser. A message containing "stall" goes silent after its first step (once
    // per text), to show the 45 s stall warning; Retry then answers normally.
    send: async (_slug, id, text, _context, _thread, _resume, opts) => {
      turnTimers.forEach(clearTimeout);
      const toClaude = !!(opts?.think || opts?.web || opts?.escalate || opts?.pin === "deep");
      const local = ollama === "ready" && !toClaude;
      const reason = opts?.escalate ? "retry" : opts?.think || opts?.pin === "deep" ? "think" : opts?.web ? "web" : ollama !== "ready" ? "unavailable" : null;
      const model = local ? localModel : opts?.think || opts?.pin === "deep" ? "claude-opus-5-5" : "claude-sonnet-5-5";
      emit({ type: "route", id, backend: local ? "local" : "claude", model, escalated: !local && ollama === "ready", reason, note: reason === "unavailable" ? "Ollama isn't installed. (mock)" : null });
      turnTimers = [];
      const at = (ms: number, fn: () => void) => turnTimers.push(window.setTimeout(fn, ms));
      const started = Date.now();
      const usage = { input: 0, cacheRead: 0, cacheCreate: 0, output: 0 };
      const call = (input: number, cached: number, output: number) => {
        usage.input += input;
        usage.cacheRead += cached;
        usage.output += output;
        emit({ type: "usage", id, ...usage });
      };
      const step = (sid: string, label: string, status: "running" | "done" | "error", extra?: Partial<ActivityStep>) =>
        emit({ type: "step", id, step: { sid, kind: "tool", label, status, startedAt: started, ...(status === "running" ? {} : { endedAt: Date.now() }), ...extra } });
      const done = (reply: string) => {
        const fallback = local && /fail/i.test(text) ? ("tool" as const) : undefined;
        emit({ type: "message_done", id, text: reply, usage: { ...usage }, durationMs: Date.now() - started, contextTokens: 1800 + 9000 + 3 * 1200, contextWindow: local ? 65536 : 200000, model, backend: local ? "local" : "claude", escalated: !local && ollama === "ready", fallback });
        // The memory pass after the turn: a muted line with its tokens, then gone.
        if (!/\/grill-me/i.test(text)) {
          emit({ type: "memory_progress", id, active: true, input: 0, output: 0 });
          at(1600, () => emit({ type: "memory_progress", id, active: true, input: 1240, output: 60 }));
          at(2600, () => emit({ type: "memory_progress", id, active: false, input: 0, output: 0 }));
        }
      };

      at(400, () => call(1800, 9000, 40));
      if (/stall/i.test(text) && !stalledOnce.has(text)) {
        stalledOnce.add(text);
        at(700, () => step("s1", 'Searching "stall"', "running", { tool: "search_cards" }));
        return; // nothing more until Stop / Retry
      }
      if (/\/grill-me/i.test(text)) {
        at(600, () => step("g1", "Reading a card", "running", { tool: "read_card" }));
        at(1300, () => step("g1", 'Read "Night market"', "done", { tool: "read_card" }));
        at(1500, () => step("g2", "Asked a question", "running", { tool: "ask_question" }));
        at(1700, () => {
          step("g2", "Asked a question", "done", { tool: "ask_question" });
          call(600, 10000, 90);
          emit({ type: "question", id, turnId: id, question: "What's the one feeling this idea should give a player in its first minute?", choices: ["Awe", "Tension", "Mischief", "Cozy calm"] });
        });
        at(1900, () => done(""));
        return;
      }
      at(700, () => step("s1", 'Searching "night market"', "running", { tool: "search_cards" }));
      at(1500, () => step("s1", 'Searched "night market" → 3 cards', "done", { tool: "search_cards" }));
      at(1700, () => emit({ type: "step", id, step: { sid: "th1", kind: "thinking", label: "Thinking", status: "running", startedAt: Date.now() } }));
      const thought = "The user asks about the market loop. Three cards touch it: the stall layout, the lantern economy and the night timer. The lantern card contradicts the timer card on how long a night lasts, so that should be pointed out before suggesting anything.".split(" ");
      thought.forEach((w, i) => at(1800 + i * 70, () => emit({ type: "thinking_delta", id, sid: "th1", text: (i ? " " : "") + w })));
      const thinkEnd = 1800 + thought.length * 70 + 100;
      at(thinkEnd, () => {
        emit({ type: "step", id, step: { sid: "th1", kind: "thinking", label: "Thinking", status: "done", startedAt: started + 1700, endedAt: Date.now() } });
        call(1200, 0, 310);
      });
      at(thinkEnd + 200, () => step("s2", "Reading a card", "running", { tool: "read_card" }));
      at(thinkEnd + 900, () => step("s2", 'Read "Lantern economy"', "done", { tool: "read_card" }));
      at(thinkEnd + 1000, () => step("s3", "Reading a card", "running", { tool: "read_card" }));
      at(thinkEnd + 1600, () => {
        step("s3", "Reading a card", "error", { tool: "read_card", detail: "card 01J… (it may have been trashed)" });
        call(1200, 0, 80);
      });
      at(thinkEnd + 1800, () => step("s4", "Looking at an attachment", "running", { tool: "view_attachment" }));
      at(thinkEnd + 2600, () => {
        step("s4", "Looked at an image", "done", { tool: "view_attachment" });
        call(1200, 0, 120);
      });
      const reply = "I'm a stand-in for Claude in browser preview — the real conversation runs through the Node sidecar inside the Tauri app.";
      const words = reply.split(" ");
      words.forEach((w, i) => at(thinkEnd + 2800 + i * 40, () => emit({ type: "delta", id, text: (i ? " " : "") + w })));
      at(thinkEnd + 2800 + words.length * 40 + 100, () => {
        call(0, 0, 140);
        done(reply);
      });
    },
    interrupt: async () => {
      turnTimers.forEach(clearTimeout);
      turnTimers = [];
    },
    onEvent: async (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    localStatus: async (): Promise<LocalStatus> => {
      const running = ollama !== "missing" && ollama !== "stopped";
      return {
        running,
        version: running ? "0.15.2" : null,
        versionOk: running,
        installed: ollama !== "missing",
        model: localModel,
        pulled: ollama === "ready",
        tools: ollama === "ready" ? true : null,
        vision: ollama === "ready" ? true : null,
        variant: ollama === "ready" ? `dreamer-${localModel}` : null,
        ready: ollama === "ready",
        pulling: pullTimers.length > 0,
        error: ollama === "missing" ? "Ollama isn't installed." : ollama === "stopped" ? "Ollama is installed but not running. Start Ollama from the Start menu." : ollama === "nomodel" ? `The model ${localModel} isn't downloaded yet.` : null,
      };
    },
    pullLocal: async () => {
      const total = 22_000_000_000;
      const emitL = (e: OllamaSetupEvent) => localListeners.forEach((l) => l(e));
      pullTimers = Array.from({ length: 20 }, (_, i) => window.setTimeout(() => emitL({ type: "progress", status: "pulling 154688af885e", completed: (total * (i + 1)) / 20, total }), 250 * (i + 1)));
      pullTimers.push(
        window.setTimeout(() => {
          pullTimers = [];
          ollama = "ready";
          emitL({ type: "done", ok: true, cancelled: false, message: "" });
        }, 250 * 22),
      );
    },
    cancelPullLocal: async () => {
      pullTimers.forEach(clearTimeout);
      pullTimers = [];
      localListeners.forEach((l) => l({ type: "done", ok: false, cancelled: true, message: "Download cancelled." }));
    },
    openOllamaInstaller: async () => {
      window.open("https://ollama.com/download/windows", "_blank", "noopener");
      if (ollama === "missing") ollama = "nomodel";
    },
    onLocalSetupEvent: async (cb) => {
      localListeners.add(cb);
      return () => localListeners.delete(cb);
    },
  };
}
