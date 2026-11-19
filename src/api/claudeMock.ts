import { isCloudModel } from "./claude";
import type { ActivityStep, ClaudeApi, ClaudeEvent, ClaudeStatus, LocalRecommendation, LocalStatus, ModelChoice, OllamaSetupEvent, SetupEvent, SetupJob } from "./claude";

/**
 * A scripted stand-in for `npm run dev` in a plain browser, where there is no sidecar to talk to.
 * `?claude=missing` or `?claude=signedout` starts in that setup state, to preview the setup screen.
 * `?ollama=missing` / `?ollama=stopped` / `?ollama=nomodel` / `?ollama=foreign` preview the local-model setup states (default: ready).
 * `?gpu=24` / `?gpu=16` / `?gpu=8` / `?gpu=2` / `?gpu=none` sets the detected VRAM in GB (default 16); 2 and none get the cloud model.
 * `?installer=badsig` / `?installer=offline` makes "Install Ollama" fail at the signature check / the download.
 * A message containing "fail" fails on the local model (shows "Retry with Claude").
 */
export function createClaudeMockApi(): ClaudeApi {
  const listeners = new Set<(e: ClaudeEvent) => void>();
  let pendingArtifact: (() => void) | null = null;
  let balance = 120;
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
  let ollama: "missing" | "stopped" | "nomodel" | "foreign" | "ready" = ollamaMode === "missing" || ollamaMode === "stopped" || ollamaMode === "nomodel" || ollamaMode === "foreign" ? ollamaMode : "ready";
  let pullTimers: number[] = [];
  let installTimers: number[] = [];
  let localModel = "qwen3.5:35b-a3b";
  let signedIn = false;
  let declined = false;
  const query = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const gpuParam = query.get("gpu") ?? "16";
  const gpuGb = gpuParam === "none" ? null : Number(gpuParam) || 16;
  const installerMode = query.get("installer");
  const CHOICES: ModelChoice[] = [
    { model: "qwen3.5:35b-a3b", label: "Qwen 3.5 35B-A3B (best)", minVramGb: 20, size: 22e9, cloud: false },
    { model: "qwen3.5:9b", label: "Qwen 3.5 9B", minVramGb: 10, size: 6.6e9, cloud: false },
    { model: "qwen3.5:4b", label: "Qwen 3.5 4B", minVramGb: 6, size: 3.3e9, cloud: false },
    { model: "gemma4:cloud", label: "Gemma 4 (Ollama cloud)", minVramGb: 0, size: 0, cloud: true },
  ];
  const recommended = () => CHOICES.find((c) => !c.cloud && gpuGb !== null && gpuGb >= c.minVramGb * 0.95) ?? CHOICES[3];
  const emitL = (e: OllamaSetupEvent) => localListeners.forEach((l) => l(e));
  const startPull = (total: number) => {
    pullTimers = Array.from({ length: 20 }, (_, i) => window.setTimeout(() => emitL({ type: "progress", status: "pulling 154688af885e", completed: (total * (i + 1)) / 20, total }), 250 * (i + 1)));
    pullTimers.push(
      window.setTimeout(() => {
        pullTimers = [];
        ollama = "ready";
        emitL({ type: "done", ok: true, cancelled: false, message: "" });
      }, 250 * 22),
    );
  };
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

  const api: ClaudeApi = {
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
      // An artifact turn (browser dev): progress, one paused credit confirm, then done. No files appear.
      if (opts?.artifact) {
        const art = opts.artifact;
        emit({ type: "route", id, backend: "claude", model: "claude-sonnet-5-5", escalated: false, reason: null, note: null });
        turnTimers = [];
        const at = (ms: number, fn: () => void) => turnTimers.push(window.setTimeout(fn, ms));
        at(300, () => emit({ type: "spritecook_status", id, artifact: art, ok: false, reason: "no_key", missing: [] }));
        at(600, () => emit({ type: "artifact_progress", id, artifact: art, label: "SpriteCook: generate game art…", progress: null, credits: 0 }));
        at(1400, () => emit({ type: "artifact_progress", id, artifact: art, label: "SpriteCook: running", progress: 0.4, credits: 2 }));
        at(2200, () => emit({ type: "credit_confirm", id, reqId: `cc-${id}`, tool: "generate_game_art", used: 4, cap: 4, more: 4, estCredits: 8 }));
        pendingArtifact = () => {
          emit({ type: "delta", id, text: "Made the hero image and the design notes (mock: nothing is saved in the browser)." });
          emit({ type: "message_done", id, text: "Made the hero image and the design notes (mock: nothing is saved in the browser).", model: "claude-sonnet-5-5", backend: "claude", artifact: { id: art, credits: 6, paidCalls: 3, jobs: [], spritecook: false } });
          balance = Math.max(0, balance - 6);
        };
        return;
      }
      // A local chat turn that asks for a visual hands it to Claude (escalate_artifact).
      if (!opts?.think && /character sheet|concept art|style guide|mockup/i.test(text)) {
        const type = /concept/i.test(text) ? "concept" : /style guide/i.test(text) ? "theme" : /mockup/i.test(text) ? "mockup" : "character";
        emit({ type: "route", id, backend: "local", model: localModel, escalated: false, reason: null, note: null });
        window.setTimeout(() => {
          emit({ type: "artifact_escalate", id, artifactType: type, brief: text, title: undefined });
          emit({ type: "message_done", id, text: "Claude is making it now in a new artifact card.", model: localModel, backend: "local" });
        }, 500);
        return;
      }
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
      const running = ollama !== "missing" && ollama !== "stopped" && ollama !== "foreign";
      const cloud = isCloudModel(localModel);
      const needsSignin = running && cloud && !signedIn;
      const ready = cloud ? running && signedIn : ollama === "ready";
      return {
        running,
        version: running ? "0.40.16" : null,
        versionOk: running,
        installed: ollama !== "missing",
        exe: ollama === "stopped" ? String.raw`C:\Users\you\AppData\Local\Programs\Ollama\ollama.exe` : null,
        host: "127.0.0.1:11434",
        hostNote: null,
        foreign: ollama === "foreign",
        model: localModel,
        cloud,
        needsSignin,
        declined: declined && !ready,
        pulled: cloud ? running && signedIn : ollama === "ready",
        tools: ready ? true : null,
        vision: ready ? true : null,
        variant: ready ? (cloud ? localModel : `dreamer-${localModel}`) : null,
        ready,
        pulling: pullTimers.length > 0,
        installing: installTimers.length > 0,
        error:
          ollama === "missing"
            ? "Ollama isn't installed."
            : ollama === "stopped"
              ? "Ollama is installed but not running. Check again starts it."
              : ollama === "foreign"
                ? "Another program is using 127.0.0.1:11434, and it isn't Ollama. (mock)"
                : needsSignin
                  ? `${localModel} runs on Ollama's servers and needs an Ollama account. Run \`ollama signin\` in a terminal, then press Check again.`
                  : declined && !ready
                    ? "No local model on this PC: its GPU is too small for one and the cloud model was declined, so chat uses Claude."
                    : !ready
                      ? `The model ${localModel} isn't downloaded yet.`
                      : null,
      };
    },
    checkLocal: async () => {
      if (ollama === "stopped") {
        await new Promise((r) => window.setTimeout(r, 1500));
        ollama = "nomodel";
      }
      // The mock "signs in" on the first Check again after a cloud model is chosen.
      if (isCloudModel(localModel)) signedIn = true;
      return api.localStatus();
    },
    installOllama: async () => {
      const total = 1.86e9;
      if (installerMode === "offline") {
        installTimers = [
          window.setTimeout(() => {
            installTimers = [];
            emitL({ type: "done", ok: false, cancelled: false, message: "No internet connection: Dreamer couldn't reach github.com to download Ollama. Check the connection and press Install again." });
          }, 600),
        ];
        return;
      }
      const steps: [number, OllamaSetupEvent][] = Array.from({ length: 10 }, (_, i): [number, OllamaSetupEvent] => [200 * (i + 1), { type: "install", phase: "download", completed: (total * (i + 1)) / 10, total }]);
      steps.push([2400, { type: "install", phase: "verify", completed: 0, total: 0 }]);
      if (installerMode === "badsig") {
        steps.push([3200, { type: "done", ok: false, cancelled: false, message: "The installer's signature didn't check out, so Dreamer didn't run it." }]);
      } else {
        steps.push([3000, { type: "install", phase: "run", completed: 0, total: 0 }], [4500, { type: "install", phase: "start", completed: 0, total: 0 }]);
      }
      installTimers = steps.map(([ms, e]) =>
        window.setTimeout(() => {
          if (e.type === "done") installTimers = [];
          emitL(e);
        }, ms),
      );
      if (installerMode !== "badsig")
        installTimers.push(
          window.setTimeout(() => {
            installTimers = [];
            ollama = "nomodel";
            const rec = recommended();
            const untouched = localModel === CHOICES[0].model;
            if (untouched && rec.cloud) {
              emitL({ type: "done", ok: true, cancelled: false, message: "" });
              return;
            }
            if (untouched) localModel = rec.model;
            startPull(CHOICES.find((c) => c.model === localModel)?.size || 22e9);
          }, 5500),
        );
    },
    cancelInstallOllama: async () => {
      installTimers.forEach(clearTimeout);
      installTimers = [];
      emitL({ type: "done", ok: false, cancelled: true, message: "Install cancelled." });
    },
    localRecommend: async (): Promise<LocalRecommendation> => ({
      gpu: gpuGb === null ? null : { name: gpuGb >= 20 ? "NVIDIA GeForce RTX 4090" : gpuGb >= 10 ? "NVIDIA GeForce RTX 4080 SUPER" : gpuGb >= 6 ? "NVIDIA GeForce RTX 4060" : "Intel(R) UHD Graphics", vram: gpuGb * 2 ** 30, source: "mock" },
      recommended: recommended(),
      choices: CHOICES,
      current: localModel,
      userPicked: localModel !== CHOICES[0].model,
    }),
    useLocalModel: async (model, download) => {
      localModel = model;
      declined = false;
      if (!isCloudModel(model) && ollama === "ready") ollama = "nomodel";
      if (download && !isCloudModel(model)) startPull(CHOICES.find((c) => c.model === model)?.size || 5e9);
      return api.localStatus();
    },
    declineLocalCloud: async () => {
      declined = true;
      return api.localStatus();
    },
    locateOllama: async () => {
      if (ollama === "missing") ollama = "stopped";
      return api.checkLocal();
    },
    pullLocal: async () => startPull(CHOICES.find((c) => c.model === localModel)?.size || 22e9),
    cancelPullLocal: async () => {
      pullTimers.forEach(clearTimeout);
      pullTimers = [];
      localListeners.forEach((l) => l({ type: "done", ok: false, cancelled: true, message: "Download cancelled." }));
    },
    openOllamaInstaller: async () => {
      window.open("https://ollama.com/download/windows", "_blank", "noopener");
    },
    onLocalSetupEvent: async (cb) => {
      localListeners.add(cb);
      return () => localListeners.delete(cb);
    },
    creditAnswer: async (reqId, allow) => {
      const id = reqId.replace(/^cc-/, "");
      emit({ type: "credit_answered", id, reqId, allow });
      window.setTimeout(() => {
        pendingArtifact?.();
        pendingArtifact = null;
      }, 600);
    },
    spritecookBalance: async () => {
      window.setTimeout(() => emit({ type: "spritecook_balance", credits: balance, error: null }), 200);
    },
  };
  return api;
}
