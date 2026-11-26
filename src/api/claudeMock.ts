import type { ActivityStep, ClaudeApi, ClaudeEvent, ClaudeStatus, SetupEvent, SetupJob } from "./claude";

/**
 * A scripted stand-in for `npm run dev` in a plain browser, where there is no sidecar to talk to.
 * `?claude=missing` or `?claude=signedout` starts in that setup state, to preview the setup screen.
 */
/** The card's title out of a verb message (`/grill-me: grill-me "Title" (id X).`); different cards give different questions. */
const title = (text: string) => text.match(/"([^"]+)"/)?.[1] ?? text;

/** Mock card-grill questions: per-card, never the project-wide topics (player, platform, scope, monetization, tone). */
const CARD_QUESTIONS = [
  [
    { id: "q1", question: "What input does this mechanic take?", choices: ["One button", "Aim and fire", "Drag"], recommended: "One button" },
    { id: "q2", question: "How does the player see the result?", choices: ["Screen shake", "Sound cue", "UI number"] },
    { id: "q3", question: "What happens on failure?", choices: ["Lose a life", "Retry instantly", "Lose progress"], context: "Failure shapes how risky the mechanic feels." },
  ],
  [
    { id: "q1", question: "Whose story is this card about?", choices: ["The player", "A rival", "A town"], recommended: "The player" },
    { id: "q2", question: "What is at stake if they fail?", choices: ["A home", "A friendship", "Nothing lasting"] },
    { id: "q3", question: "Does it contradict the linked cards' ending?", choices: ["No", "Yes, change this", "Yes, change the other"] },
  ],
];
const PROJECT_QUESTIONS = [
  { id: "q1", question: "Who is the target player?", choices: ["Casual", "Core", "Kids"], recommended: "Core", context: "Shapes difficulty and session length." },
  { id: "q2", question: "Which platform comes first?", choices: ["PC", "Mobile", "Console"] },
  { id: "q3", question: "What is the scope?", choices: ["Jam-sized", "Small indie", "Long project"] },
  { id: "q4", question: "What makes the project different?", choices: ["The mechanic", "The art", "The story"] },
];

/** One canned reply per verb (the mock makes no cards). */
const CANNED: [RegExp, string][] = [
  [/^\/expand/, "Proposed 3 child cards (mock)."],
  [/^\/critique/, "The most serious issue: the loop has no failure state (mock)."],
  [/Give me 3 takes/, "Proposed 3 takes (mock)."],
  [/^\/what-if/, "Proposed 3 what-ifs: no timer, a co-op swap, a single-screen scale (mock)."],
  [/^\/related/, "Proposed 2 links (mock)."],
  [/^\/references/, "Web access is off. Turn it on with the globe button, then run Find references again (mock)."],
  [/^\/describe/, "Proposed captions and tags (mock)."],
];

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
        emit({ type: "route", id, model: "claude-sonnet-5-5" });
        turnTimers = [];
        const at = (ms: number, fn: () => void) => turnTimers.push(window.setTimeout(fn, ms));
        at(300, () => emit({ type: "spritecook_status", id, artifact: art, ok: false, reason: "no_key", missing: [] }));
        at(600, () => emit({ type: "artifact_progress", id, artifact: art, label: "SpriteCook: generate game art…", progress: null, credits: 0 }));
        at(1400, () => emit({ type: "artifact_progress", id, artifact: art, label: "SpriteCook: running", progress: 0.4, credits: 2 }));
        at(2200, () => emit({ type: "credit_confirm", id, reqId: `cc-${id}`, tool: "generate_game_art", used: 4, cap: 4, more: 4, estCredits: 8 }));
        pendingArtifact = () => {
          emit({ type: "delta", id, text: "Made the hero image and the design notes (mock: nothing is saved in the browser)." });
          emit({ type: "message_done", id, text: "Made the hero image and the design notes (mock: nothing is saved in the browser).", model: "claude-sonnet-5-5", artifact: { id: art, credits: 6, paidCalls: 3, jobs: [], spritecook: false } });
          balance = Math.max(0, balance - 6);
        };
        return;
      }
      // A chat turn that asks for a visual hands it to an artifact turn (escalate_artifact).
      if (!opts?.think && /character sheet|concept art|style guide|mockup/i.test(text)) {
        const type = /concept/i.test(text) ? "concept" : /style guide/i.test(text) ? "theme" : /mockup/i.test(text) ? "mockup" : "character";
        emit({ type: "route", id, model: "claude-sonnet-5-5" });
        window.setTimeout(() => {
          emit({ type: "artifact_escalate", id, artifactType: type, brief: text, title: undefined });
          emit({ type: "message_done", id, text: "Claude is making it now in a new artifact card.", model: "claude-sonnet-5-5" });
        }, 500);
        return;
      }
      const model = opts?.think || opts?.pin === "deep" ? "claude-opus-5-5" : "claude-sonnet-5-5";
      emit({ type: "route", id, model });
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
        emit({ type: "message_done", id, text: reply, usage: { ...usage }, durationMs: Date.now() - started, contextTokens: 1800 + 9000 + 3 * 1200, contextWindow: 200000, model });
        // The memory pass after the turn: a muted line with its tokens, then gone.
        if (!/\/grill-(me|project)/i.test(text)) {
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
      if (/\/grill-(me|project)/i.test(text)) {
        at(600, () => step("g1", "Reading a card", "running", { tool: "read_card" }));
        at(1300, () => step("g1", 'Read "Night market"', "done", { tool: "read_card" }));
        // /grill-me checklist: one question per listed `[item_id] question — context` line (up to 4).
        const items = [...text.matchAll(/^\[([^\]]+)\] (.+?)(?: — (.+))?$/gm)].slice(0, 4);
        const questions = items.length
          ? items.map((m, i) => ({ id: `q${i + 1}`, itemId: m[1], question: m[2], choices: ["Yes", "No", "Later"], recommended: "Yes", ...(m[3] ? { context: m[3] } : {}) }))
          : /\/grill-project/.test(text)
            ? PROJECT_QUESTIONS
            : CARD_QUESTIONS[(title(text).length + (title(text).charCodeAt(0) || 0)) % CARD_QUESTIONS.length];
        at(1500, () => step("g2", "Asked questions", "running", { tool: "ask_questions" }));
        at(1700, () => {
          step("g2", "Asked questions", "done", { tool: "ask_questions" });
          call(600, 10000, 90);
          emit({ type: "questions", id, turnId: id, questions });
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
      const reply = CANNED.find(([re]) => re.test(text))?.[1] ?? "I'm a stand-in for Claude in browser preview — the real conversation runs through the Node sidecar inside the Tauri app.";
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
