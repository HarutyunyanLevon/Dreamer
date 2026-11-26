import { contextWindowOf, fromApiUsage, makeTracker } from "./activity.mjs";
import { dlog, fail, send, text } from "./io.mjs";
import { WEB_TOOLS, closeSession, openSession } from "./session.mjs";
import { SPRITECOOK, SPRITECOOK_TOOLS, onSpritecookResult } from "./spritecook.mjs";

// Last line of defence: log it (stderr goes to sidecar.log), fail the turn in progress, and keep
// serving. The session that was answering is closed, since its state is unknown; the thread's next
// message resumes it from the saved session id.
export function onFatal(kind, e) {
  console.error(`[sidecar] ${kind}: ${e?.stack ?? e}`);
  const t = current;
  if (t && !t.ended) {
    try {
      failTurn(t, "error", `Claude's helper hit an internal error (${e?.message ?? e}). Retry to continue.`);
    } catch (e2) {
      console.error(`[sidecar] could not fail the turn: ${e2?.stack ?? e2}`);
      current = null;
    }
  }
}
process.on("uncaughtException", (e) => onFatal("uncaughtException", e));
process.on("unhandledRejection", (e) => onFatal("unhandledRejection", e));
// ---- Per-turn tool limits for chat turns (the model cannot loop on reads): at most ONE of
// read_card / view_attachment, and at most 4 calls of any kind. Search and listing are not tools
// any more: Rust attaches related cards to each message. ----
const LIMIT_MSG = "limit reached, answer with what you have";
/** Results Dreamer's own guards produce (a limit, an ended turn, a question already asked): normal results, never a failed call. */
export const GUARD_RE = /^(Error: )?(limit reached|this turn has ended|The question was already asked)/;
export const guard = (msg) => ({ content: [{ type: "text", text: msg }] });
const ASKED_MSG = "The question was already asked and is shown to the user. Do not call any tool; end your turn now and write nothing.";
function makeLimits(text = "", artifact = false) {
  // /merge and /describe read several cards / images by design: larger allowance.
  const merge = /^[/](merge|describe)/.test(text);
  // /organize (Claude agent path): list_tree, then propose_organize, with room to fix a rejected plan.
  const organize = /^[/]organize/.test(text);
  // An artifact turn saves files, notes and suggestions (SpriteCook calls are not counted here).
  return artifact
    ? { calls: 0, reads: 0, maxCalls: 40, maxReads: 6, hit: false, hits: 0 }
    : { calls: 0, reads: 0, maxCalls: merge ? 16 : organize ? 8 : 4, maxReads: merge ? 12 : 1, hit: false, hits: 0 };
}
/**
 * An error result when this call would pass a limit, or when the session's turn is already over
 * (a late call from a stopped turn must not act on the next one); otherwise counts the call.
 */
export function turnGate(s, kind) {
  const t = s.turn;
  if (!t || t.ended || t.s !== s) return guard("this turn has ended; stop now and write nothing more");
  // ask_question ends the turn: a later call in it does nothing.
  if (t.questionAsked) return guard(ASKED_MSG);
  const l = t.limits;
  if (l.calls >= l.maxCalls || (kind === "read" && l.reads >= l.maxReads)) {
    l.hit = true;
    l.hits++;
    // A model that got "limit reached" can keep calling the same tool. The third refused call ends the turn instead.
    if (l.hits >= 3) {
      dlog(`limit_loop turn=${t.id} hits=${l.hits}`);
      // With something to show (a question, a ghost card, text) the turn simply ends there.
      const tr = s.tracker?.turn === t ? s.tracker : null;
      setImmediate(() => ((tr?.actions() ?? 0) > 0 || t.text.trim() ? endTurnEarly(s, t, "limit") : failTurn(t, "limit", "The model kept calling tools after its limit and was stopped.")));
    }
    return guard(l.hits >= 2 ? `${LIMIT_MSG}. Do not call any more tools: write your answer now.` : LIMIT_MSG);
  }
  l.calls++;
  if (kind === "read") l.reads++;
  return null;
}

// ---- Turns ----
//
// One object per chat turn. Everything the sidecar sends about a turn goes through emit(t, ...),
// which drops it once the turn has ended (so a late event of a stopped or stalled turn never lands
// on the next one) and feeds the turn's watchdog. `current` is the turn the UI is waiting for.

export let current = null;
export const setCurrent = (t) => { current = t; };

/** Watchdog limits: the first model event (a model load plus reading a big context), then between events. */
export const FIRST_EVENT_MS = Number(process.env.DREAMER_FIRST_EVENT_CLAUDE_MS) || 60000;
export const IDLE_MS = Number(process.env.DREAMER_IDLE_MS) || 45000;
/** A running tool keeps its own limit (a SpriteCook generation or a web fetch takes longer than a model pause). */
const toolLimitMs = (name) => (SPRITECOOK_TOOLS.includes(name) ? 300000 : WEB_TOOLS.includes(name) ? 120000 : 60000);
/** Budget of the step before the model runs: the thread summary (compaction). */
export const SUMMARY_MS = 120000;
const HEARTBEAT_MS = 10000;
/** Tools whose success means the turn did its job even without text. */
export const ACTION_TOOLS = new Set(["create_card", "ask_question", "ask_questions", "propose_link", "merge_cards", "propose_edit", "propose_organize", "propose_reference", "remember", "forget", "escalate_artifact", "propose_artifact"]);

export function newTurn(msg, { artifact, model }) {
  const now = Date.now();
  return {
    id: msg.id,
    artifact: !!artifact,
    model,
    userText: msg.text,
    startedAt: now,
    phase: "prep",
    prepUntil: 0,
    modelStartedAt: 0,
    firstModelAt: 0,
    lastAt: now,
    lastType: "start",
    ended: false,
    endReason: null,
    s: null,
    limits: makeLimits(msg.text, !!artifact),
    waits: new Map(),
    userWait: 0,
    text: "",
    questionAsked: false,
    escalatedArtifact: false,
    pendingFull: null,
    retryModel: null,
    retried: false,
    retriedFrom: null,
    tier: null,
    lastInput: null,
    prepQuery: null,
  };
}

export const touch = (t) => {
  if (t && !t.ended) t.lastAt = Date.now();
};

/** Sends an event of turn `t` (dropped once it has ended). `fromModel`: model output, which ends the first-event wait. */
export function emit(t, obj, fromModel = false) {
  if (!t || t.ended) return false;
  const now = Date.now();
  t.lastAt = now;
  t.lastType = obj.type;
  if (fromModel && !t.firstModelAt && t.phase === "model") t.firstModelAt = now;
  send({ ...obj, id: t.id });
  return true;
}

/** Binds a turn to the session that answers it. */
export function attach(t, s) {
  t.s = s;
  s.turn = t;
  s.busy = true;
  s.lastUsed = Date.now();
  s.tracker = null;
}

/** When the turn counts as stalled (ms epoch), or Infinity while it waits for the user. */
function turnDeadline(t) {
  if (t.userWait > 0) return Infinity;
  let d =
    t.phase === "prep"
      ? Math.max(t.prepUntil, t.lastAt + IDLE_MS)
      : t.firstModelAt
        ? t.lastAt + IDLE_MS
        : t.modelStartedAt + FIRST_EVENT_MS;
  for (const until of t.waits.values()) d = Math.max(d, until);
  const tr = t.s?.tracker?.turn === t ? t.s.tracker : null;
  for (const st of tr?.running() ?? []) d = Math.max(d, st.startedAt + toolLimitMs(st.tool));
  return d;
}

const stallWhy = (t) =>
  t.phase === "prep"
    ? "the thread summary took too long"
    : !t.firstModelAt
      ? `no reply from the model within ${Math.round(FIRST_EVENT_MS / 1000)}s`
      : `no activity for ${Math.round(IDLE_MS / 1000)}s`;

// The watchdog: one tick a second over the turn the UI waits for. A heartbeat (not activity) tells
// the app the sidecar itself is alive, so its own watchdog only fires when this process is wedged.
setInterval(() => {
  const t = current;
  if (!t || t.ended) return;
  const now = Date.now();
  if (now > turnDeadline(t)) {
    dlog(`turn_stall turn=${t.id} phase=${t.phase} why="${stallWhy(t)}" last=${t.lastType}@${t.lastAt - t.startedAt}ms`);
    failTurn(t, "stalled", `Claude stopped responding (${stallWhy(t)}). Retry to send it again.`);
    return;
  }
  if (now - (t.aliveAt ?? t.startedAt) >= HEARTBEAT_MS) {
    t.aliveAt = now;
    send({ type: "alive", id: t.id, phase: t.phase, idleMs: now - t.lastAt });
  }
}, 1000).unref?.();

/** One diagnostics line per turn: sizes, ids and times only. */
function logTurnEnd(t, reason) {
  const tr = t.s?.tracker?.turn === t ? t.s.tracker : null;
  const tools = (tr?.toolLog() ?? []).map((x) => `${x.tool}:${x.ms}ms:${x.status}`).join(",");
  const ttfe = t.firstModelAt ? t.firstModelAt - t.modelStartedAt : -1;
  dlog(
    `turn_end turn=${t.id} model=${t.model ?? "-"} reason=${reason} ` +
      `ttfe_ms=${ttfe} ` +
      `last_event=${t.lastType}@${t.lastAt - t.startedAt}ms dur_ms=${Date.now() - t.startedAt} tools=[${tools}]`,
  );
}

/** Marks a turn over: nothing of it is sent any more. */
export function markEnded(t, reason) {
  if (t.ended) return;
  logTurnEnd(t, reason);
  t.ended = true;
  t.endReason = reason;
  try {
    t.prepQuery?.close?.();
  } catch {
    /* gone */
  }
  if (current === t) current = null;
}

/**
 * The turn failed (`reason`: error | empty | stalled | limit | tool). It ends with a clear reason;
 * retrying is the user's click.
 */
export function failTurn(t, reason, message) {
  if (!t || t.ended) return;
  const s = t.s;
  const tr = s?.tracker?.turn === t ? s.tracker : null;
  // A second real tool error: the model is fine, its call is not. Keep the session and its history.
  if (s && !s.closed) {
    if (reason === "tool") settle(s, t);
    else closeSession(s, reason);
  }
  tr?.finish(true);
  emit(t, { type: "error", message, endReason: reason });
  markEnded(t, reason);
}

/** Stops what a session generates for turn `t` but keeps the session; one that does not settle is closed. */
export function settle(s, t) {
  s.q.interrupt?.().catch(() => {});
  setTimeout(() => {
    if (s.busy && !s.closed && s.turn === t) closeSession(s, "wedged");
  }, 8000).unref?.();
}

/**
 * The turn is done before the model stopped: ask_question succeeded (the question card is the
 * answer), or the model looped on a limit after it had produced something. It ends as a normal
 * turn and the session stays, so the user's answer goes to the session that asked.
 */
function endTurnEarly(s, t, why) {
  if (t.ended || t.s !== s) return;
  dlog(`turn_end_early turn=${t.id} why=${why}`);
  finishTurn(s, t, { type: "result", subtype: "success", is_error: false, result: "", session_id: s.sessionId, num_turns: 0 });
  if (!s.closed) settle(s, t);
}

/** A saved session that can't be resumed (deleted, expired): start the thread afresh and replay the turn. */
function restartFresh(s) {
  const t = s.turn;
  dlog(`session_restart session=${s.sid} key=${s.key} turn=${t?.id ?? "-"} why=resume_failed`);
  closeSession(s);
  if (!t || t.ended || t.s !== s) return;
  let fresh;
  try {
    fresh = openSession(s.key, null, s.model, s.think, s.artifact);
  } catch (e) {
    console.error(`[sidecar] could not start a fresh session after a failed resume: ${e?.stack ?? e}`);
    return failTurn(t, "error", `Claude could not start a new session: ${e?.message ?? e}`);
  }
  fresh.web = s.web;
  attach(t, fresh);
  // A fresh session knows nothing: replay the waiting turn with the full context.
  dlog(`session_restart_replay turn=${t.id} sent=fullText`);
  const replay = t.pendingFull ?? s.pending;
  fresh.pending = replay;
  fresh.turns.push(replay);
}

/** The turn answered on the fast model gave an error, an empty answer, or ran into a tool limit with no real answer. */
function shouldRetryOnMain(t, msg) {
  if (!t.retryModel || t.retried || t.questionAsked || t.s?.closed) return false;
  // An error is a failure: no automatic Claude retry (the user gets Retry). Only a thin answer
  // from the fast model is redone on the main one.
  if (msg.is_error) return false;
  const answer = (msg.subtype === "success" ? msg.result : t.text) ?? "";
  const empty = !String(answer).trim();
  return empty || (t.limits.hit && String(answer).trim().length < 40);
}

function retryOnMain(s, t) {
  t.retriedFrom = s.model;
  t.retried = true;
  s.model = t.retryModel;
  s.q.setModel?.(t.retryModel).catch(() => {});
  dlog(`retry_on_main turn=${t.id} from=${t.retriedFrom} to=${s.model}`);
  t.text = "";
  t.lastInput = null;
  t.limits = makeLimits(t.userText);
  s.busy = true;
  // The result consumed the turn; the same turn goes in again.
  s.turns.push(s.pending);
  emit(t, { type: "model_note", model: s.model, retried: true, from: t.retriedFrom });
}

/**
 * An artifact session started: is SpriteCook there, and does it offer every tool Dreamer relies on?
 * Anything missing is logged; the UI shows a note (with a link to Settings) when images can't be made.
 */
function checkSpritecook(s, init, t) {
  const status = (init.mcp_servers ?? []).find((m) => m.name === "spritecook")?.status;
  const tools = new Set(init.tools ?? []);
  const missing = SPRITECOOK_TOOLS.filter((x) => !tools.has(`mcp__spritecook__${x}`));
  let reason = null;
  if (!SPRITECOOK.key) reason = "no_key";
  else if (status && status !== "connected") reason = "unreachable";
  else if (missing.length === SPRITECOOK_TOOLS.length) reason = "unreachable";
  s.spritecookOk = !reason;
  dlog(`spritecook key=${SPRITECOOK.key ? "set" : "none"} status=${status ?? "absent"} missing=${missing.length ? missing.join(",") : "none"}`);
  emit(t, { type: "spritecook_status", artifact: s.artifact?.id ?? null, ok: !reason, reason, missing: reason ? [] : missing });
}

/** The result of the turn a session was answering. */
function finishTurn(s, t, msg) {
  const tr = s.tracker?.turn === t ? s.tracker : null;
  const text = t.questionAsked && !msg.is_error ? "" : msg.subtype === "success" ? msg.result : t.text;
  tr?.finish(msg.is_error);
  const usage = tr?.hasUsage() ? tr.usage() : fromApiUsage(msg.usage);
  dlog(`turn_done turn=${t.id} calls=${msg.num_turns} sum_input=${usage.input} sum_cacheRead=${usage.cacheRead} sum_cacheCreate=${usage.cacheCreate} output=${usage.output} lastCallContext=${tr?.contextTokens?.() ?? 0} answerChars=${String(text).length}`);
  const u = msg.usage ?? {};
  const contextTokens = (tr?.hasUsage() && tr.contextTokens()) || t.lastInput || (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const endReason = msg.is_error ? "error" : "done";
  emit(t, {
    type: "message_done",
    text,
    sessionId: msg.session_id,
    isError: msg.is_error,
    inputTokens: contextTokens,
    usage: { ...usage, ...(tr?.hasUsage() ? { calls: tr.calls() } : {}) },
    durationMs: Date.now() - t.startedAt,
    // The model this turn was routed to. modelUsage also lists Claude Code's own cheap
    // background calls (Haiku), so its first key is not reliably the answering model.
    model: s.model || Object.keys(msg.modelUsage ?? {})[0] || undefined,
    tier: t.tier ?? undefined,
    endReason,
    ...(s.artifact ? { artifact: { id: s.artifact.id, credits: s.credits?.spent ?? 0, paidCalls: s.credits?.calls ?? 0, jobs: s.credits?.jobs ?? [], spritecook: s.spritecookOk !== false } } : {}),
    ...(t.retried ? { retried: true, retriedFrom: t.retriedFrom } : {}),
    contextTokens,
    contextWindow: contextWindowOf(msg),
  });
  markEnded(t, endReason);
  s.web = false;
}

export function pump(s) {
  (async () => {
    try {
      for await (const msg of s.q) {
        const t = s.turn;
        // The turn these events belong to; only a live one is forwarded.
        const live = !!t && !t.ended && t.s === s;
        if (msg.type === "system" && msg.subtype === "init") {
          s.sessionId = msg.session_id;
          // A resume that worked keeps the saved session id; a different one means the history was not loaded.
          if (s.artifact && live) checkSpritecook(s, msg, t);
          dlog(`session_init session=${s.sid} key=${s.key} pid=${s.child?.pid ?? "?"} resumeRequested=${s.resume ? "yes" : "no"} resumed=${s.resume ? msg.session_id === s.resume : "n/a"} session_id=${msg.session_id} model=${msg.model} tools=${msg.tools?.length ?? "?"} mcp=${JSON.stringify((msg.mcp_servers ?? []).map((m) => `${m.name}:${m.status}`))}`);
        }
        // Artifact turns: SpriteCook results are counted (credits, jobs) and shown as progress.
        if (s.artifact && live && !msg.parent_tool_use_id) {
          if (msg.type === "assistant") {
            for (const b of msg.message?.content ?? []) {
              if (b?.type === "tool_use") {
                (s.toolNames ??= new Map()).set(b.id, b.name);
                if (String(b.name).startsWith("mcp__spritecook__")) emit(t, { type: "artifact_progress", artifact: s.artifact.id, label: `SpriteCook: ${String(b.name).replace(/^mcp__spritecook__/, "").replace(/_/g, " ")}…`, progress: null, credits: s.credits?.spent ?? 0 });
              }
            }
          } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
            for (const b of msg.message.content) {
              const name = b?.type === "tool_result" && s.toolNames?.get(b.tool_use_id);
              if (name && String(name).startsWith("mcp__spritecook__")) onSpritecookResult(s, t, name, b.content, !!b.is_error);
            }
          }
        }
        if (live && msg.type !== "result") {
          if (!s.tracker || s.tracker.turn !== t) {
            s.tracker = makeTracker((o) => emit(t, o, true), `turn=${t.id}`);
            s.tracker.turn = t;
          }
          s.tracker.on(msg);
          if (msg.type === "user" && t.questionAsked && s.tracker.asked()) endTurnEarly(s, t, "question");
        }
        if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
          s.answered = true;
          if (live) {
            t.text += msg.event.delta.text;
            if (!t.questionAsked) emit(t, { type: "delta", text: msg.event.delta.text }, true);
          }
        } else if (msg.type === "assistant" && !msg.parent_tool_use_id && msg.message?.usage) {
          // The latest model call's input is the thread's real context size (a result's usage adds
          // up every call of a tool-using turn).
          const u = msg.message.usage;
          if (process.env.DREAMER_DEBUG_USAGE) dlog(`raw assistant usage ${JSON.stringify(u)} id=${msg.message.id}`);
          if (live) t.lastInput = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          if (msg.message?.error && live) dlog(`api_error turn=${t.id} ${String(msg.message.error).slice(0, 120)}`);
        } else if (msg.type === "result") {
          // A resume that can't find its session reports a zero-turn error result (then throws):
          // don't surface it, recover below by starting the thread afresh.
          if (msg.is_error && msg.num_turns === 0 && s.resume && !s.answered) {
            s.resumeFailed = true;
            continue;
          }
          s.answered = true;
          s.busy = false;
          if (!live) {
            // A stopped turn's result: swallowed, it must not land on the next turn.
            if (t) dlog(`late_result session=${s.sid} turn=${t.id} ended=${t.endReason ?? "?"}`);
            continue;
          }
          // A router-picked fast turn that came back thin: once more on the main model.
          if (shouldRetryOnMain(t, msg)) {
            retryOnMain(s, t);
            continue;
          }
          finishTurn(s, t, msg);
        }
      }
      if (s.resumeFailed && !s.closed) {
        console.error(`[sidecar] resume failed for a thread; starting it afresh`);
        restartFresh(s);
        return;
      }
      // The stream ended without throwing (Claude Code exited) while a turn was still waiting.
      if (!s.closed) {
        closeSession(s);
        const t = s.turn;
        if (t && !t.ended && t.s === s) {
          console.error(`[sidecar] Claude session ended without a result`);
          failTurn(t, "error", "Claude Code stopped without answering. Retry to start a new session.");
        }
      }
    } catch (e) {
      if (s.closed) return;
      console.error(`[sidecar] session error: ${e?.stack ?? e}`);
      const t = s.turn;
      // A saved session that can't be resumed (deleted, expired): start that thread afresh and
      // replay the turn that was waiting, instead of failing the user's message.
      if (s.resume && !s.answered && t && !t.ended && t.s === s) {
        restartFresh(s);
        return;
      }
      closeSession(s, "error");
      if (t && !t.ended && t.s === s) failTurn(t, "error", e?.message ?? String(e));
    }
  })().catch((e) => {
    // Anything thrown by the recovery itself must not leave the turn pending.
    console.error(`[sidecar] pump failed: ${e?.stack ?? e}`);
    const t = s.turn;
    if (t && !t.ended) failTurn(t, "error", `Claude stopped unexpectedly: ${e?.message ?? e}`);
  });
}
