import { makeServer } from "./tools/index.mjs";
import { spawn as spawnChild } from "node:child_process";
import { makeTurnQueue } from "./activity.mjs";
import { dlog, query } from "./io.mjs";
import { SYSTEM_PROMPT, artifactSystem } from "./prompts/system.mjs";
import { FREE_TOOLS, spritecookServer } from "./spritecook.mjs";
import { artifactGate, artifactSpecs, makeArtifactServer } from "./tools/artifactSession.mjs";
import { current, emit, pump } from "./turn.mjs";

// ---- Sessions: one Claude session per chat thread ("<project>/<card id | project>") ----
//
// Each thread gets its own long-lived query() whose async-iterable prompt carries that thread's
// turns. A thread's Claude session id is saved by the UI in the thread's chat file and passed
// back as `resume`, so a thread continues where it left off even after Dreamer restarts. At most
// MAX_LIVE sessions run at once (each is a Claude Code process); the least recently used idle one
// is closed and simply resumed later. "Reset chat" drops the thread's session so its next message
// starts a fresh one.
//
// A session answers ONE turn at a time (s.turn). A new turn never queues behind one that has not
// finished (a stopped or wedged one): that session is closed and the thread continues in a new
// process, resumed from the saved session id. So the head of a queue can never block the next turn.

const MAX_LIVE = 3;
/** Fixed token budget for a chat session's context (not a % of the model's window). */
const AUTO_COMPACT_TOKENS = Number(process.env.DREAMER_COMPACT_TOKENS) || 60000;
export const sessions = new Map();
let sessionSeq = 0; export const nextSession = () => ++sessionSeq;
/** Threads in a checklist grill (ask_questions' item_id counts only there). */
export const checklistThreads = new Set();
export const WEB_TOOLS = ["WebSearch", "WebFetch"];

const BASE_OPTIONS = {
  systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
  allowedTools: [
    "mcp__dreamer__create_card",
    "mcp__dreamer__ask_question",
    "mcp__dreamer__ask_questions",
    "mcp__dreamer__read_card",
    "mcp__dreamer__propose_link",
    "mcp__dreamer__merge_cards",
    "mcp__dreamer__view_attachment",
    "mcp__dreamer__propose_edit",
    "mcp__dreamer__propose_reference",
    "mcp__dreamer__remember",
    "mcp__dreamer__forget",
    "mcp__dreamer__list_tree",
    "mcp__dreamer__propose_organize",
    "mcp__dreamer__escalate_artifact",
    "mcp__dreamer__propose_artifact",
  ],
  // The only built-in tools offered. They are not in allowedTools, so every call goes through
  // canUseTool (see webGate), which allows them only on a turn the user switched web access on.
  tools: WEB_TOOLS,
  // Extended thinking is off unless the user turns "Think" on for a message (see thinkingOption).
  permissionMode: "default",
  // Ignore the user's own Claude Code settings: an "allow WebFetch" rule there would skip the gate.
  settingSources: [],
  includePartialMessages: true,
};

/** Ends a Claude Code process for sure (and what it started): a stalled one may ignore stdin EOF. */
export function killChild(s) {
  const c = s.child;
  if (!c || c.exitCode != null || c.killed) return;
  dlog(`kill_child session=${s.sid} pid=${c.pid}`);
  try {
    if (process.platform === "win32" && c.pid) spawnChild("taskkill", ["/F", "/T", "/PID", String(c.pid)], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else c.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Closes a session. `why` other than "close" (a stall, a wedged or superseded session) also kills
 * its Claude Code process at once and drops its model connections, so nothing keeps generating.
 */
export function closeSession(s, why = "close") {
  if (sessions.get(s.key) === s) sessions.delete(s.key);
  if (s.closed) return;
  s.closed = true;
  s.turns.end();
  try {
    s.q.close?.();
  } catch {
    /* already gone */
  }
  if (why !== "close") {
    dlog(`session_close session=${s.sid} key=${s.key} why=${why}`);
    killChild(s);
  }
}

function evictIfNeeded() {
  while (sessions.size >= MAX_LIVE) {
    const idle = [...sessions.values()].filter((s) => !s.busy && s.turn !== current).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) break;
    closeSession(idle);
  }
}

/**
 * Per-tool permission callback for one session. Dreamer's own tools are auto-allowed through
 * allowedTools and never reach here; WebSearch/WebFetch do, and pass only while the current turn
 * has web access on (`s.web`, set per message and cleared when the turn ends).
 */
function webGate(s) {
  return async (toolName, input) => {
    if (!WEB_TOOLS.includes(toolName)) return { behavior: "deny", message: `${toolName} is not available in Dreamer.` };
    if (!s.web) {
      return { behavior: "deny", message: "Web access is off for this message. The user can switch it on with the globe button next to the chat input." };
    }
    if (toolName === "WebFetch" && typeof input.url === "string") (s.fetched ??= new Set()).add(input.url);
    if (toolName === "WebFetch" && typeof input.url === "string") emit(s.turn?.s === s ? s.turn : null, { type: "web_fetch", url: input.url });
    return { behavior: "allow", updatedInput: input };
  };
}

export const THINK_BUDGET = 4000;
const thinkingOption = (think) => (think ? { type: "enabled", budgetTokens: THINK_BUDGET } : { type: "disabled" });

/** Starts Claude Code ourselves (same command the SDK would run) so a stalled one can be killed by pid. */
export const spawner = (s) => (opts) => {
  const child = spawnChild(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  s.child = child;
  child.on("error", (e) => dlog(`child_error session=${s.sid} ${e?.code ?? e?.message}`));
  child.on("exit", (code, sig) => {
    if (!s.closed) dlog(`child_exit session=${s.sid} pid=${child.pid} code=${code} signal=${sig}`);
  });
  return child;
};

/** `artifact` = {id, cap} for an artifact thread. */
export function openSession(key, resume, model, think = false, artifact = null) {
  evictIfNeeded();
  const turns = makeTurnQueue();
  const sid = `s${nextSession()}`;
  const s = { sid, key, artifact: artifact ? { ...artifact } : null, q: null, turns, resume: resume || null, model: model || null, think: !!think, web: false, lastUsed: Date.now(), answered: false, pending: null, closed: false, busy: false, turn: null, tracker: null, child: null, sessionId: resume || null };
  s.q = query({
    prompt: turns,
    options: {
      ...BASE_OPTIONS,
      thinking: thinkingOption(think),
      canUseTool: webGate(s),
      mcpServers: { dreamer: makeServer(s) },
      // Claude Code's own auto-compact is a % of the model's window (~800k+ on a 1M model, i.e. never).
      // Pin the window it computes against to a fixed budget, so it also compacts mid-turn.
      env: {
        ...process.env,
        CLAUDE_CODE_MAX_RETRIES: "2",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(AUTO_COMPACT_TOKENS),
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      },
      spawnClaudeCodeProcess: spawner(s),
      // An artifact thread: its own prompt and tools, SpriteCook included (when a key is set).
      ...(artifact
        ? {
            systemPrompt: { type: "custom", prompt: artifactSystem() },
            allowedTools: [...artifactSpecs.map((t) => `mcp__dreamer__${t.name}`), ...FREE_TOOLS.map((t) => `mcp__spritecook__${t}`)],
            tools: [],
            canUseTool: artifactGate(s),
            mcpServers: { dreamer: makeArtifactServer(s), ...(spritecookServer() ? { spritecook: spritecookServer() } : {}) },
          }
        : {}),
      // Only Dreamer's own tools (and SpriteCook in artifact threads): never the user's other MCP
      // servers or claude.ai connectors.
      strictMcpConfig: true,
      ...(model ? { model } : {}),
      ...(resume ? { resume } : {}),
    },
  });
  sessions.set(key, s);
  pump(s);
  return s;
}
