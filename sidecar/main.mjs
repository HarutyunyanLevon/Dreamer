// Node sidecar: bridges Dreamer's chat panel to the Claude Agent SDK, which in turn drives
// the user's locally installed, already-logged-in Claude Code — no API key.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   in:  {type:"user_message", id, text, fullText, thread, resume?, model?, tier?, think?, retryModel?, web?, compact?}
//        (model/tier chosen by the router in Rust; think = thinking budget on; retryModel = main model for
//         one retry when a fast turn errors or comes back empty -> {type:"model_note", id, model, retried})
//                                    -- text = the user's words plus only what changed since the last
//                                       message; fullText = the same with the whole project context. A
//                                       session's first message (no resume), a failed resume and the
//                                       first message after a compaction use fullText, the rest text.
//                                       compact = {transcript, model}: summarize the thread first (a
//                                       one-shot query, no tools), reply {type:"compacted"}, and start
//                                       a fresh session; fullText holds "{{SUMMARY}}" for the result
//                                    -- thread = "<project>/<card id|project>"; web = this turn may
//                                       use WebSearch/WebFetch (off unless the user turned it on)
//        {type:"reset_thread", thread}                    -- "Reset chat": drop that thread's session
//        {type:"interrupt", hard?}                        -- hard: also close the session (Retry after a stall)
//        {type:"tool_response", reqId, result} | {type:"tool_response", reqId, error}
//        {type:"oneshot_start", job, prompt, model}
//                                    -- a handoff pack session: its own one-turn query, not a chat
//                                       thread; tools are handoff_* requests carrying the job id
//        {type:"oneshot_cancel", job}                      -- interrupt it; Rust drops its output
//        {type:"memory_start", job, kind:"update"|"seed", prompt, model}
//                                    -- a memory pass: one query, no history, no built-in tools; its one
//                                       tool call (memory_update | memory_seed) comes back as memory_result
//   out: {type:"ready"}
//        {type:"delta", id, text}                      -- streamed assistant text
//        {type:"questions", id, turnId, questions:[{id, question, choices, recommended?, context?, item?, itemId?}]}
//                                                       -- ask_questions / ask_question fired during turn `turnId`
//        {type:"message_done", id, text, sessionId, isError, inputTokens, usage, durationMs, contextTokens,
//         contextWindow}                                -- contextTokens (= inputTokens) = the last model call's
//                                                          input (incl. cache reads/creation); usage = the turn's
//                                                          {input, cacheRead, cacheCreate, output}
//        {type:"step", id|job, step}                     -- a tool call or thinking block started/ended (makeTracker)
//        {type:"thinking_delta", id|job, sid, text}      -- streamed thinking text of step `sid`
//        {type:"usage", id|job, phase?, input, cacheRead, cacheCreate, output}  -- cumulative, after every
//                                                          API call; phase "compact" = the thread summary
//        {type:"compacted", id, summary}                 -- the thread was summarized before turn `id`
//        {type:"tool_request", reqId, tool, input}      -- Rust must reply (create_card, search_cards,
//                                                          read_card, list_cards, list_related, propose_link,
//                                                          merge_cards, view_attachment, propose_edit,
//                                                          list_tree, propose_organize)
//        {type:"search", id, query, results}            -- search_cards ran (chat shows result chips)
//        {type:"link_proposal", id, slug, from, to, label, reason}  -- a ghost link to Keep/Dismiss
//        {type:"edit_proposal", id, slug, card, title}   -- propose_edit saved a proposal file
//        {type:"organize_proposal", id, plan}           -- propose_organize passed validation (the UI previews it)
//        {type:"web_fetch", id, url}                     -- WebFetch ran (chat offers "Save as clip")
//        {type:"error", id, message}
//        {type:"oneshot_done", job, ok, error?, cancelled?}  -- a handoff session ended
//        {type:"memory_result", job, result}             -- the memory pass's tool input (first call only)
//        {type:"memory_done", job, ok}                   -- the memory pass ended
//        (remember / forget are chat tools: tool_request with the running turn id attached)
import { setCurrent } from "./turn.mjs";
import { createInterface } from "node:readline";
import { makeTracker } from "./activity.mjs";
import { CLAUDE_EXE, dlog, pendingToolReplies, send, text } from "./io.mjs";
import { cancelOneshot, completions, oneshots, startCompletion, startMemory, startOneshot, summarize } from "./jobs.mjs";
import { SUMMARY_SLOT } from "./prompts/jobs.mjs";
import { THINK_BUDGET, checklistThreads, closeSession, openSession, sessions } from "./session.mjs";
import { DEFAULT_CREDIT_CAP, denyPendingCredits, pendingCredit, sendBalance } from "./spritecook.mjs";
import { SUMMARY_MS, attach, current, emit, failTurn, markEnded, newTurn } from "./turn.mjs";

async function handleUserMessage(msg) {
  const key = msg.thread || "default";
  const model = typeof msg.model === "string" && msg.model ? msg.model : null;
  const artifact = msg.artifact?.id ? { id: String(msg.artifact.id), cap: Number(msg.artifact.cap) || DEFAULT_CREDIT_CAP } : null;
  // The UI sends one turn at a time; a new one while another runs means the UI gave up on that one.
  if (current && !current.ended) {
    const old = current;
    dlog(`turn_superseded turn=${old.id} by=${msg.id}`);
    markEnded(old, "superseded");
    send({ type: "turn_ended", id: old.id, reason: "superseded" });
    if (old.s && !old.s.closed && old.s.busy) closeSession(old.s, "superseded");
  }
  const t = newTurn(msg, { artifact, model });
  setCurrent(t);
  const thread = key;
  // A checklist grill lasts until another command starts in that thread.
  if (/^\/grill-me checklist/.test(msg.text ?? "")) checklistThreads.add(thread);
  else if (/^\//.test(msg.text ?? "")) checklistThreads.delete(thread);
  let s = sessions.get(key);
  let resume = msg.resume;
  // Still answering an earlier turn (stopped, or wedged): never queue behind it. Close that
  // process and continue the thread in a new one, resumed from the session it had.
  if (s && s.busy) {
    dlog(`session_busy key=${key} session=${s.sid} turn=${s.turn?.id ?? "-"} -> reopen`);
    resume = s.sessionId || resume;
    closeSession(s, "busy");
    s = undefined;
  }
  const sessionWasLive = !!s;
  let fullText = msg.fullText ?? msg.text;
  let useFull = !s && !resume;
  if (msg.compact) {
    // Shown as the turn's first step, with its own token count.
    t.prepUntil = Date.now() + SUMMARY_MS + 5000;
    const step = { sid: "compact", kind: "tool", tool: "compact", label: "Summarizing earlier messages…", status: "running", startedAt: Date.now() };
    emit(t, { type: "step", step });
    const tracker = makeTracker((o) => o.type === "usage" && emit(t, { ...o, phase: "compact" }));
    const summary = await summarize(msg.compact, tracker, { turn: t });
    if (t.ended) return;
    emit(t, { type: "step", step: { ...step, label: summary ? "Summarized earlier messages" : "Could not summarize earlier messages", status: summary ? "done" : "error", endedAt: Date.now() } });
    if (summary) {
      emit(t, { type: "compacted", summary });
      if (s) closeSession(s);
      s = undefined;
      resume = null;
      useFull = true;
      fullText = fullText.replace(SUMMARY_SLOT, summary);
    } else {
      fullText = fullText.replace(SUMMARY_SLOT, "(summary unavailable)");
    }
  }
  if (t.ended) return;
  const think = msg.think === true;
  // The thread's session was opened for the other mode (chat vs artifact) or is gone: reopen it.
  s = s && !s.closed ? s : sessions.get(key);
  if (s && (s.closed || s.busy)) s = undefined;
  if (s && !!s.artifact !== !!artifact) {
    closeSession(s);
    s = undefined;
  }
  s = s ?? openSession(key, resume, model, think, artifact);
  if (artifact) s.artifact = artifact;
  // The router (or a pin) picked another model than the session runs: switch it for this turn.
  if (model && s.model !== model) {
    s.model = model;
    s.q.setModel?.(model).catch(() => {});
  }
  // "Think" differs from the session's state: thinking budget on for this turn, off again after.
  if (s.think !== think) {
    s.think = think;
    s.q.setMaxThinkingTokens?.(think ? THINK_BUDGET : 0).catch(() => {});
  }
  t.retryModel = !think && typeof msg.retryModel === "string" && msg.retryModel ? msg.retryModel : null;
  t.tier = typeof msg.tier === "string" ? msg.tier : null;
  s.web = msg.web === true;
  s.credits = { calls: 0, units: 0, spent: 0, jobs: [], allowed: artifact?.cap ?? 0 };
  const turn = (x) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: x }] }, parent_tool_use_id: null });
  t.pendingFull = turn(fullText);
  s.pending = useFull ? t.pendingFull : turn(msg.text);
  t.phase = "model";
  t.modelStartedAt = Date.now();
  dlog(
    `turn_start turn=${msg.id} thread=${key} session=${sessionWasLive ? "live" : resume ? "resume" : "fresh"} sid=${s.sid} model=${model ?? "-"} ` +
      `sent=${useFull ? "fullText" : "text"} sentChars=${useFull ? fullText.length : msg.text.length} textChars=${msg.text.length} fullTextChars=${fullText.length} compacted=${!!msg.compact}`,
  );
  attach(t, s);
  s.turns.push(s.pending);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "user_message") {
    // query() can throw before the first event (bad options, Claude Code missing): that turn must
    // still end, with an error the UI shows.
    handleUserMessage(msg).catch((e) => {
      console.error(`[sidecar] could not start turn ${msg.id}: ${e?.stack ?? e}`);
      if (current?.id === msg.id) failTurn(current, "error", `Claude could not start: ${e?.message ?? e}`);
      else send({ type: "error", id: msg.id, message: `Claude could not start: ${e?.message ?? e}` });
    });
  } else if (msg.type === "oneshot_start") {
    startOneshot(msg);
  } else if (msg.type === "memory_start") {
    startMemory(msg);
  } else if (msg.type === "complete_start") {
    startCompletion(msg);
  } else if (msg.type === "complete_cancel") {
    completions.get(msg.job)?.cancel();
  } else if (msg.type === "oneshot_cancel") {
    cancelOneshot(msg.job);
  } else if (msg.type === "credit_answer") {
    pendingCredit.get(msg.reqId)?.(msg.allow === true);
  } else if (msg.type === "spritecook_balance") {
    sendBalance();
  } else if (msg.type === "ping") {
    send({ type: "pong", n: msg.n ?? null });
  } else if (msg.type === "interrupt" || msg.type === "abort_turn") {
    // interrupt = the Stop button (the UI has already ended the turn); hard = Retry after a stall;
    // abort_turn = the app's own watchdog gave up on that turn.
    const t = msg.type === "abort_turn" ? (current?.id === msg.id ? current : null) : current;
    denyPendingCredits();
    if (!t) return;
    const s = t.s;
    const why = msg.type === "abort_turn" ? "aborted" : msg.hard ? "interrupted-hard" : "interrupted";
    markEnded(t, why);
    send({ type: "turn_ended", id: t.id, reason: why });
    if (!s || s.closed) return;
    if (msg.hard || msg.type === "abort_turn") {
      closeSession(s, why);
      return;
    }
    s.q.interrupt?.().catch(() => {});
    // A session that does not settle after the interrupt is wedged: close it, so the thread's next
    // message gets a working process (resumed from the saved session).
    setTimeout(() => {
      if (s.busy && !s.closed && s.turn === t) closeSession(s, "wedged");
    }, 8000).unref?.();
  } else if (msg.type === "reset_thread") {
    for (const s of [...sessions.values()].filter((x) => x.key === msg.thread)) {
      if (s.turn && !s.turn.ended) {
        const t = s.turn;
        markEnded(t, "reset");
        send({ type: "turn_ended", id: t.id, reason: "reset" });
      }
      closeSession(s, s.busy ? "reset" : "close");
    }
  } else if (msg.type === "tool_response") {
    const pending = pendingToolReplies.get(msg.reqId);
    if (!pending) {
      dlog(`tool_response_late req=${msg.reqId} (after its timeout; dropped)`);
      return;
    }
    clearTimeout(pending.timer);
    pendingToolReplies.delete(msg.reqId);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  }
});

// Dreamer closed our stdin (it quit, crashed or was stopped): end every Claude session and exit,
// so no Claude Code process outlives the app. (On Windows the app's job object also ends this
// whole process tree; this covers other platforms and a graceful path everywhere.)
rl.on("close", () => {
  for (const s of [...sessions.values()]) closeSession(s);
  for (const job of [...oneshots.keys()]) cancelOneshot(job);
  for (const c of [...completions.values()]) c.cancel();
  setTimeout(() => process.exit(0), 200);
});

console.error(`[sidecar] started: node ${process.version}, cwd ${process.cwd()}, claude ${CLAUDE_EXE || "(SDK default)"}`);
send({ type: "ready" });
