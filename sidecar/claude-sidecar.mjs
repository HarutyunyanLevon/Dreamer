// Node sidecar: bridges Dreamer's chat panel to the Claude Agent SDK, which in turn drives
// the user's locally installed, already-logged-in Claude Code — no API key.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   in:  {type:"user_message", id, text, fullText, thread, resume?, model?, tier?, think?, retryModel?, web?, compact?,
//         backend:"local"|"claude", escalated?, local?:{baseUrl, vision}, recap?:{transcript, model}}
//        (backend "local" = this turn runs on a local model through Ollama's Anthropic-compatible API:
//         its own session, keyed "<thread>#local", with Ollama env. escalated = a one-turn Claude visit
//         from a local thread: a fresh session that is closed after the turn; recap = have the local
//         model recap the thread first and put it in fullText's "{{RECAP}}" slot)
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
//        {type:"oneshot_start", job, mode:"gaps"|"generate"|"task", prompt, model}
//                                    -- a handoff pack session: its own one-turn query, not a chat
//                                       thread; tools are handoff_* requests carrying the job id
//        {type:"oneshot_cancel", job}                      -- interrupt it; Rust drops its output
//        {type:"scan_start", job, cwd, prompt, model}   -- repo scan: Read/Glob/Grep in cwd, tools scan_* (list_cards,
//                                       report_progress, emit_bundle); ends with scan_done {job, ok, error?}.
//                                       Cancel with oneshot_cancel.
//        {type:"build_start", run, cwd, prompt, model}  -- a build run's task: Claude Code itself in the repo
//                                       (its CLAUDE.md and .claude settings), every tool call gated by Rust
//                                       (tool_request build_permission). One session per task.
//        {type:"build_cancel", run}                        -- Interrupt: stop it, kill its process
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
//        {type:"compacted", id, summary, backend}        -- the thread was summarized before turn `id`
//        message_done also carries backend, escalated and, for a local turn that failed, fallback:
//         "error"|"empty"|"tool"|"vision" (the UI offers "Retry with Claude")
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
//        {type:"build_step"|"build_text"|"build_usage", run, ...}  -- a build run's activity
//        {type:"build_done", run, ok, error?, cancelled?, stalled?} -- its task ended
//        (remember / forget are chat tools: tool_request with the running turn id attached)
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createSdkMcpServer, query as sdkQuery, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

// The user's installed Claude Code (resolved by the app, see sidecar.rs). Release builds ship
// the SDK without its bundled per-platform binary, so this is what every query() runs.
const CLAUDE_EXE = process.env.DREAMER_CLAUDE_EXE || "";
const query = (args) =>
  sdkQuery({ ...args, options: { ...(CLAUDE_EXE ? { pathToClaudeCodeExecutable: CLAUDE_EXE } : {}), ...args.options } });

// ---- Fault injection for the reliability harness (scripts/reliability). Inert unless set. ----
// DREAMER_FAKE_CLAUDE_URL: Claude sessions talk to this fake Anthropic server instead (stall tests,
// no real usage). DREAMER_FAKE_LOCAL_URL: local sessions talk to it instead of Ollama.
const FAKE_CLAUDE_URL = process.env.DREAMER_FAKE_CLAUDE_URL || "";
const FAKE_LOCAL_URL = process.env.DREAMER_FAKE_LOCAL_URL || "";
const claudeEnv = () => (FAKE_CLAUDE_URL ? { ...process.env, ANTHROPIC_BASE_URL: FAKE_CLAUDE_URL, ANTHROPIC_AUTH_TOKEN: "fake", ANTHROPIC_API_KEY: "" } : process.env);

// ---- SpriteCook (artifact images), through its remote MCP server ----
// URL from Settings, key from the OS credential store (both passed by the app at spawn). The key is
// removed from our env at once, so no Claude Code process inherits it; it only goes into the MCP
// server's Authorization header of artifact sessions.
const SPRITECOOK = { url: process.env.DREAMER_SPRITECOOK_URL || "https://api.spritecook.ai/mcp/", key: process.env.DREAMER_SPRITECOOK_KEY || "" };
delete process.env.DREAMER_SPRITECOOK_KEY;
const DEFAULT_CREDIT_CAP = Number(process.env.DREAMER_CREDIT_CAP) || 4;
/** The SpriteCook tools artifact sessions may use (checked against the live list at session init). */
const SPRITECOOK_TOOLS = [
  "generate_game_art", "generate_character", "make_rotation_sheet", "generate_character_animations", "check_character_animation_run",
  "animate_game_art", "remove_background", "create_ui_kit", "generate_ui_kit_concepts", "select_ui_kit_concept",
  "generate_ui_kit_component_sheets", "extract_ui_kit_components", "finalize_ui_kit", "get_ui_kit", "check_job_status",
  "get_asset_metadata", "get_credit_balance", "create_project", "assign_assets_to_project", "list_presets",
  "get_preset_settings", "save_private_preset", "import_asset", "create_asset_upload", "finalize_asset_upload",
];
/** Calls that spend credits: they go through the per-turn cap (artifactGate) instead of allowedTools. */
const PAID_TOOLS = new Set([
  "generate_game_art", "generate_character", "make_rotation_sheet", "generate_character_animations", "animate_game_art",
  "remove_background", "create_ui_kit", "generate_ui_kit_concepts", "generate_ui_kit_component_sheets", "extract_ui_kit_components", "finalize_ui_kit",
]);
/** These count by the credits they report, not as one call. */
const CREDIT_COUNTED = new Set(["generate_character_animations", "animate_game_art", "create_ui_kit", "generate_ui_kit_concepts", "generate_ui_kit_component_sheets", "extract_ui_kit_components", "finalize_ui_kit"]);
const FREE_TOOLS = SPRITECOOK_TOOLS.filter((t) => !PAID_TOOLS.has(t));
const spritecookServer = () => (SPRITECOOK.key ? { type: "http", url: SPRITECOOK.url, headers: { Authorization: `Bearer ${SPRITECOOK.key}` } } : null);

const pendingToolReplies = new Map();
let reqSeq = 0;

/** One diagnostics line in sidecar.log (the app records our stderr there). Sizes and ids only, never content. */
const dlog = (line) => console.error(`[ctx] ${line}`);
const sizeOfContent = (c) =>
  typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (b?.type === "text" ? (b.text ?? "").length : b?.type === "image" ? (b.source?.data ?? b.data ?? "").length : 0), 0) : 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// The app reads stdout; if that pipe is gone there is nobody left to answer.
process.stdout.on("error", () => process.exit(1));

// Last line of defence: log it (stderr goes to sidecar.log), fail the turn in progress, and keep
// serving. The session that was answering is closed, since its state is unknown; the thread's next
// message resumes it from the saved session id.
function onFatal(kind, e) {
  console.error(`[sidecar] ${kind}: ${e?.stack ?? e}`);
  const t = current;
  if (t && !t.ended) {
    try {
      failTurn(t, "error", `Claude's helper hit an internal error (${e?.message ?? e}). Retry to continue.`, { noRetry: true });
    } catch (e2) {
      console.error(`[sidecar] could not fail the turn: ${e2?.stack ?? e2}`);
      current = null;
    }
  }
}
process.on("uncaughtException", (e) => onFatal("uncaughtException", e));
process.on("unhandledRejection", (e) => onFatal("unhandledRejection", e));

/**
 * Asks Rust for something and waits for its tool_response. `t`: the turn this belongs to; while the
 * request is out, the turn's watchdog waits for this request's own timeout instead of its idle limit.
 */
function requestTool(tool_, input, timeoutMs = 15000, t = null) {
  const reqId = `r${++reqSeq}`;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const settle = () => t?.waits.delete(reqId);
    const timer = setTimeout(() => {
      pendingToolReplies.delete(reqId);
      settle();
      dlog(`tool_timeout turn=${t?.id ?? "-"} tool=${tool_} req=${reqId} after_ms=${timeoutMs}`);
      reject(new Error("timed out waiting for the app"));
    }, timeoutMs);
    pendingToolReplies.set(reqId, {
      resolve: (v) => {
        settle();
        if (Date.now() - startedAt > 2000) dlog(`tool_slow turn=${t?.id ?? "-"} tool=${tool_} req=${reqId} ms=${Date.now() - startedAt}`);
        resolve(v);
      },
      reject: (e) => {
        settle();
        reject(e);
      },
      timer,
    });
    t?.waits.set(reqId, Date.now() + timeoutMs + 5000);
    send({ type: "tool_request", reqId, tool: tool_, input });
  });
}

// Nothing Claude reads (tool results included) may be bigger than this; the app trims too, this is the backstop.
const MAX_TOOL_CHARS = 8000;
const DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^,;\s)"'<>]*)*,[^\s)"'<>\]]*/gi;
/** Drops data:/base64 URIs and caps the length. */
function trimForClaude(t, max = MAX_TOOL_CHARS) {
  let out = String(t ?? "").replace(DATA_URI, "[embedded data omitted]");
  if (out.length > max) out = `${out.slice(0, max)}\n…truncated (${out.length - max} more chars), use read_card`;
  return out;
}
const text = (v, max) => ({ content: [{ type: "text", text: trimForClaude(typeof v === "string" ? v : JSON.stringify(v, null, 1), max) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

// ---- Per-turn tool limits for chat turns (the model cannot loop on reads): at most ONE of
// read_card / view_attachment, and at most 4 calls of any kind. Search and listing are not tools
// any more: Rust attaches related cards to each message. ----
const LIMIT_MSG = "limit reached, answer with what you have";
/** Results Dreamer's own guards produce (a limit, an ended turn, a question already asked): normal results, never a failed call. */
const GUARD_RE = /^(Error: )?(limit reached|this turn has ended|The question was already asked)/;
const guard = (msg) => ({ content: [{ type: "text", text: msg }] });
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
function turnGate(s, kind) {
  const t = s.turn;
  if (!t || t.ended || t.s !== s) return guard("this turn has ended; stop now and write nothing more");
  // ask_question ends the turn: a later call in it does nothing.
  if (t.questionAsked) return guard(ASKED_MSG);
  const l = t.limits;
  if (l.calls >= l.maxCalls || (kind === "read" && l.reads >= l.maxReads)) {
    l.hit = true;
    l.hits++;
    // Seen live: a local model that got "limit reached" kept calling the same tool 6 more times,
    // then hung. The third refused call ends the turn instead.
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

const requestToolT = requestTool;
const sendRaw = send;

/** Dreamer's chat tools for one session: every call belongs to the turn that session is answering. */
function chatTools(s) {
  const T = () => s.turn;
  const tid = () => s.turn?.id ?? null;
  const live = () => !!s.turn && !s.turn.ended && s.turn.s === s;
  const hitLimit = (kind) => turnGate(s, kind);
  const requestTool = (name, input, ms = 15000) => requestToolT(name, input, ms, T());
  // Sent only while the turn is live: a late call of a stopped turn changes nothing.
  const send = (o) => {
    if (live()) {
      touch(s.turn);
      sendRaw(o);
    }
  };
  // Project versions: every tool works in the open version (see the "Version:" context line) unless given another.
  const VERSION_ARG = z
    .string()
    .optional()
    .describe("Project version title (e.g. 'v1') to write into instead of the open one. Only when the user explicitly asked for that version in this message; otherwise omit.");
  const VERSION_READ_ARG = z.string().optional().describe("Project version title (e.g. 'v1') to read from instead of the open one");
  const createCardTool = tool(
    "create_card",
    "Propose a new idea card on the user's canvas. It is always created as a ghost suggestion (dashed outline) " +
      "that the user must explicitly Keep before it counts; never claim it is final. You cannot delete cards.",
    {
      title: z.string().describe("Short card title"),
      body: z.string().optional().describe("Markdown notes for the card body"),
      tags: z.array(z.string()).optional(),
      stage: z.enum(["mist", "reverie", "lucid", "dream", "built"]).optional(),
      links: z.array(z.object({ to: z.string(), label: z.string().optional() })).optional(),
      linked_from: z
        .object({ id: z.string(), label: z.string().max(40).optional() })
        .optional()
        .describe("Propose a link from this existing card to the new one (shown as a ghost link the user keeps or dismisses)"),
      kind: z.enum(["card", "sticky", "checklist"]).optional().describe("Object kind (default 'card'). Use 'checklist' with items for a list of points or questions."),
      items: z
        .array(z.object({ text: z.string(), question: z.boolean().optional().describe("true when the item is an open question") }))
        .optional()
        .describe("Checklist items (kind 'checklist' only)"),
      branch_group: z.string().optional().describe("When proposing several alternative takes together (e.g. '3 takes'), use the exact same branch_group value on every one of them so Dreamer can group and compare them."),
      variant_of: z.string().optional().describe("The id of the card these takes branch from, if any."),
      version: VERSION_ARG,
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        const { linked_from, ...rest } = args;
        const card = await requestTool("create_card", rest);
        let note = "";
        if (linked_from) {
          try {
            const ok = await requestTool("propose_link", { from: linked_from.id, to: card.id });
            send({ type: "link_proposal", id: tid(), slug: ok.slug, from: linked_from.id, to: card.id, label: linked_from.label });
            note = ` Proposed a ghost link from "${ok.fromTitle}".`;
          } catch (e) {
            note = ` (Could not propose the link: ${e.message})`;
          }
        }
        return { content: [{ type: "text", text: `Created ghost card "${card.title}" (id ${card.id}). It awaits the user's Keep/Dismiss.${note}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not create the card: ${e.message}` }], isError: true };
      }
    },
  );

  const HANDOFF_ARG = z
    .string()
    .optional()
    .describe("Only in the handoff gap interview: the exact checklist item this question is about. Omit otherwise.");
  /** Shows `qs` as one question form; ask_question and ask_questions both end here. */
  const askQuestions = (qs) => {
    {
      const lim = hitLimit("any");
      if (lim) return lim;
    }
    // turnId ties the form to the reply it belongs to, so the UI shows it once, as the question
    // form, instead of also showing any streamed text for that turn. `item` tells the UI where the
    // answer goes (handoff gap interview: Tech card or Project decisions card).
    // Seen live: the local model fills handoff_item in a plain card grill, which sent the answer to
    // the Project decisions card instead of the card. It counts only inside a gap interview; item_id
    // likewise only inside a checklist grill.
    const thread = threadOf(s.key);
    const gap = gapThreads.has(thread);
    const checklist = checklistThreads.has(thread);
    const questions = qs.map((q, i) => ({
      id: q.id || `q${i + 1}`,
      question: q.question,
      choices: q.choices,
      // A recommended value that is not one of the choices is dropped rather than failing the turn.
      ...(q.recommended && q.choices.includes(q.recommended) ? { recommended: q.recommended } : {}),
      ...(q.context ? { context: q.context } : {}),
      ...(gap && q.handoff_item ? { item: q.handoff_item } : {}),
      ...(checklist && q.item_id ? { itemId: q.item_id } : {}),
    }));
    send({ type: "questions", id: `q${++reqSeq}`, turnId: tid(), questions });
    // Anything the model writes after asking is noise ("the question is above"): drop it, so the
    // turn is the question form and nothing else.
    if (T()) T().questionAsked = true;
    // Observed live: without a firm stop here the model sometimes kept going and wrote a guessed
    // "[Answer] ..." itself. The real answer only ever comes as the user's next message.
    return {
      content: [
        {
          type: "text",
          text: "The questions are now shown to the user as buttons. END YOUR TURN NOW: write nothing more, do not guess or state an answer. The user's real answers will arrive as their next message.",
        },
      ],
    };
  };
  // Kept for older threads and models that still call it: a batch of one.
  const askQuestionTool = tool(
    "ask_question",
    "Ask the user exactly one multiple-choice question. Prefer ask_questions. Present 2-5 short, neutral, concrete " +
      "choices. The question is shown to the user with buttons, so do not also write it as text.",
    { question: z.string(), choices: z.array(z.string()).min(2).max(5), handoff_item: HANDOFF_ARG },
    async (args) => askQuestions([args]),
  );
  const askQuestionsTool = tool(
    "ask_questions",
    "Ask the user 1-4 multiple-choice questions at once (used for /grill-me), shown as one form with buttons, so do " +
      "not also write them as text. Each has 2-5 short, neutral, concrete choices. Wait for the answers as the next " +
      "message before asking more.",
    {
      questions: z
        .array(
          z.object({
            id: z.string().optional(),
            question: z.string(),
            choices: z.array(z.string()).min(2).max(5),
            recommended: z.string().optional().describe("Your recommended choice; must equal one of the choices"),
            context: z.string().optional().describe("Short background for the question, shown under it"),
            item_id: z.string().optional().describe("Only in /grill-me checklist: the [item_id] this question answers. Omit otherwise."),
            handoff_item: HANDOFF_ARG,
          }),
        )
        .min(1)
        .max(4),
    },
    async (args) => askQuestions(args.questions),
  );

  const readCardTool = tool(
    "read_card",
    "Read one card in full by id: title, kind, stage, tags, fields, body, checklist items, role, its links (with the " +
      "linked cards' titles) and its attachments (id, type, caption; for web clips also title, url and has_excerpt). " +
      "Use view_attachment to look at an image or read a clip's saved text.",
    { id: z.string(), version: VERSION_READ_ARG },
    async (args) => {
      {
        const lim = hitLimit("read");
        if (lim) return lim;
      }
      try {
        return text(await requestTool("read_card", { id: args.id, version: args.version }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  const proposeLinkTool = tool(
    "propose_link",
    "Propose a link between two cards in the open project. It appears as a dashed ghost link the user must Keep " +
      "or Dismiss; it is NOT created. Only propose links you can justify from the cards' content.",
    {
      from: z.string().describe("Card id the link starts from"),
      to: z.string().describe("Card id the link points to"),
      label: z.string().max(40).optional().describe("2-4 word label for the line, e.g. 'same boss', 'inverts'"),
      reason: z.string().optional().describe("One sentence on why they connect"),
      version: VERSION_ARG,
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        const ok = await requestTool("propose_link", { from: args.from, to: args.to, version: args.version });
        send({ type: "link_proposal", id: tid(), slug: ok.slug, from: args.from, to: args.to, label: args.label, reason: args.reason });
        return text(`Proposed a ghost link "${ok.fromTitle}" → "${ok.toTitle}". It awaits the user's Keep/Dismiss.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const mergeCardsTool = tool(
    "merge_cards",
    "Propose merging 2+ cards of the open project into ONE card. Read every card with read_card first, then write " +
      "one synthesized title and a markdown body that keeps every distinct idea from the originals (no filler). " +
      "Dreamer creates it as a ghost card; stage and links are taken from the originals automatically. Only if the " +
      "user Keeps it are the originals moved to Trash, by the app. You cannot delete cards.",
    {
      ids: z.array(z.string()).min(2).describe("Ids of the cards to merge"),
      title: z.string().describe("Synthesized title"),
      body: z.string().describe("Synthesized markdown body"),
      tags: z.array(z.string()).optional(),
      version: VERSION_ARG,
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        const card = await requestTool("merge_cards", args);
        return text(`Proposed merged ghost card "${card.title}" (id ${card.id}). It awaits the user's Keep/Dismiss.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const viewAttachmentTool = tool(
    "view_attachment",
    "Look at one attachment of a card in the open project (ids come from read_card). An image is returned as " +
      "an image (downscaled); a web clip returns the page text saved when it was clipped, or 'no excerpt'.",
    {
      card_id: z.string(),
      attachment_id: z.string(),
    },
    async (args) => {
      {
        const lim = hitLimit("read");
        if (lim) return lim;
      }
      try {
        const r = await requestTool("view_attachment", args);
        const ls = s;
        if (r.kind === "image" && ls?.local && !ls.vision) {
          if (T()) T().visionBlocked = true;
          return fail(new Error("the local model can't look at images. Tell the user in one sentence that this needs Claude (Retry with Claude) and answer from the text you have"));
        }
        if (r.kind === "image") {
          return {
            content: [
              { type: "text", text: `Image ${args.attachment_id}${r.caption ? ` (caption: ${r.caption})` : " (no caption)"}:` },
              { type: "image", data: r.data, mimeType: r.mime },
            ],
          };
        }
        const head = `Web clip ${args.attachment_id}: ${r.title ? `"${r.title}" ` : ""}<${r.url}>${r.caption ? ` (caption: ${r.caption})` : ""}`;
        return text(`${head}\n\n${r.text}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const proposeEditTool = tool(
    "propose_edit",
    "Propose changes to an existing card: a new title, body, tags (the full new list), stage, and/or captions " +
      "for its attachments. Nothing changes until the user keeps it: the card shows a 'Claude suggests changes' " +
      "badge and a diff. One pending proposal per card; a new one replaces the previous. Only include the fields " +
      "you change. The body replaces the whole body, so keep everything the user wrote unless asked otherwise.",
    {
      card_id: z.string(),
      title: z.string().optional(),
      body: z.string().optional().describe("The complete new markdown body"),
      tags: z.array(z.string().max(40)).optional().describe("The complete new tag list"),
      stage: z.enum(["mist", "reverie", "lucid", "dream", "built"]).optional(),
      captions: z.record(z.string(), z.string().max(200)).optional().describe("New captions keyed by attachment id"),
      reason: z.string().describe("One sentence on why, shown to the user"),
      version: VERSION_ARG,
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        const ok = await requestTool("propose_edit", args);
        send({ type: "edit_proposal", id: tid(), slug: ok.slug, card: args.card_id, title: ok.title });
        return text(`Proposed changes to "${ok.title}". The card shows them for the user to Keep or Dismiss; nothing has changed yet.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---- Organize: read the tree, then propose one reviewable plan (Rust validates it whole) ----
  const listTreeTool = tool(
    "list_tree",
    "List the folders, frames and cards in scope, compactly: ids, titles, tags, stage, folder, position, pinned " +
      "and links. Call it once before propose_organize.",
    { scope: z.enum(["folder", "project"]).optional().describe("folder (default): the open folder and below; project: everything"), version: VERSION_READ_ARG },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        return text(await requestTool("list_tree", { scope: args.scope ?? "folder", version: args.version }), 30000);
      } catch (e) {
        return fail(e);
      }
    },
  );

  const organizeOp = z.object({
    op: z.enum(["create_frame", "rename", "arrange", "place", "retag"]),
    tempId: z.string().optional().describe("create_frame: your id for the new frame, usable by later ops"),
    id: z.string().optional().describe("rename: frame id; retag: card id"),
    ids: z.array(z.string()).optional().describe("arrange: card ids"),
    title: z.string().optional().describe("create_frame / rename"),
    color: z.string().optional(),
    rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional().describe("create_frame"),
    layout: z.enum(["grid", "cluster-by-tag", "flow-by-links", "stage-columns"]).optional().describe("arrange"),
    positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional().describe("place: card id -> new top-left position"),
    add: z.array(z.string()).optional().describe("retag: tags to add"),
    remove: z.array(z.string()).optional().describe("retag: tags to remove"),
  });

  const proposeOrganizeTool = tool(
    "propose_organize",
    "Propose ONE reorganization plan: ordered ops the user reviews, previews on the canvas and applies or discards. " +
      "Nothing changes until they apply it. It works inside the open folder only, with frames, layout and tags: " +
      "folders are project versions and a plan never creates, renames or moves folders or moves cards between them. " +
      "Ops: create_frame {tempId, title, rect}, rename {id, title} (frames only), arrange {ids, layout}, place " +
      "{positions: {card id: {x, y}}}, retag {id, add, remove}. Never deletes and never edits card text. Pinned cards " +
      "keep their position: leave them out. If it returns an error, fix every listed op and call it again with the whole plan.",
    {
      scope: z.enum(["folder", "project"]).describe("The scope you listed with list_tree"),
      rationale: z.string().describe("One paragraph: the idea behind the plan"),
      ops: z.array(organizeOp),
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        const plan = await requestTool("propose_organize", args);
        send({ type: "organize_proposal", id: tid(), plan });
        const kept = plan.kept?.length ? ` ${plan.kept.length} pinned item(s) are kept in place.` : "";
        return text(`Showed the plan (${plan.ops.length} ops) to the user; nothing has changed yet.${kept} Reply with one short sentence; do not repeat the plan.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Explicit memory edits ("remember ...", "forget ..."). Rust applies them to memory.md (source
  // "claude") and tells the chat; the automatic memory pass handles everything else.
  const rememberTool = tool(
    "remember",
    "Save one line to the project's memory. Use ONLY when the user explicitly asks you to remember something " +
      "(\"remember ...\"). Otherwise a separate automatic pass keeps the memory; never call this on your own.",
    {
      text: z.string().describe("One short, durable line in the user's words"),
      section: z.enum(["Pitch", "Pillars", "Decisions", "Rejected", "Glossary", "How to work with me"]).optional().describe("Default: Decisions"),
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        return text(await requestTool("remember", { ...args, turn: tid() }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  const forgetTool = tool(
    "forget",
    "Remove a line from the project's memory. Use ONLY when the user explicitly asks (\"forget ...\", \"that's no " +
      "longer true\"). Pass the text of the line (or enough of it to identify it).",
    { text: z.string() },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        return text(await requestTool("forget", { ...args, turn: tid() }));
      } catch (e) {
        return fail(e);
      }
    },
  );


  // Chat sessions (local or Claude) never make images: an artifact request is handed to an artifact
  // turn on Claude, in the new artifact's own thread. The app creates the artifact card and sends it.
  const escalateArtifactTool = tool(
    "escalate_artifact",
    "Hand a request for a visual artifact to Claude, who makes it with SpriteCook in a new artifact card: a theme " +
      "(style guide: palette, fonts, mood, key art), a character design, a concept art piece, or an interactive HTML " +
      "mockup. Call it once when the user asks for one; you cannot make images yourself. The brief says exactly what " +
      "the user asked for (no extras) plus the relevant facts from the conversation and cards.",
    {
      type: z.enum(ARTIFACT_TYPES),
      brief: z.string().describe("What to make, in the user's terms, with the relevant context"),
      title: z.string().max(80).optional().describe("Short card title, e.g. 'Fish priest'"),
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      send({ type: "artifact_escalate", id: tid(), artifactType: args.type, brief: args.brief, title: args.title });
      if (T()) T().escalatedArtifact = true;
      return text("Handed over: Dreamer is creating the artifact card and Claude is making it now in that card's thread. END YOUR TURN with one short sentence saying so.");
    },
  );

  // Deepen / grill: Claude may propose an artifact as a ghost card (a brief only, nothing spent).
  const proposeArtifactTool = tool(
    "propose_artifact",
    "Propose a visual artifact as a ghost card (a brief only: nothing is generated or spent until the user keeps it; " +
      "keeping it makes Claude generate it). Use sparingly, in /grill-me or /expand, when seeing something would settle " +
      "a design question (a character's look, a place's mood, a screen's layout, the game's style).",
    {
      type: z.enum(ARTIFACT_TYPES),
      title: z.string().max(80),
      brief: z.string().describe("What to make and which question it answers"),
      source_card: z.string().optional().describe("The card it visualizes (id)"),
      version: VERSION_ARG,
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        const r = await requestTool("propose_artifact", args);
        return text(`Proposed the ${args.type} "${r.title}" as a ghost card; nothing is generated until the user keeps it.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return [createCardTool, askQuestionTool, askQuestionsTool, readCardTool, proposeLinkTool, mergeCardsTool, viewAttachmentTool, proposeEditTool, rememberTool, forgetTool, listTreeTool, proposeOrganizeTool, escalateArtifactTool, proposeArtifactTool];
}

// A fresh MCP server instance per session: an SDK server object binds to one transport.
const makeServer = (s) => createSdkMcpServer({ name: "dreamer", version: "1.0.0", tools: chatTools(s) });

const ARTIFACT_TYPES = ["theme", "character", "concept", "mockup"];

// The checklist /grill-me works through, in order. Kept here so the prompt and any future UI
// progress indicator agree on what "every item covered" means.
const GRILL_ITEMS = [
  "core experience (what the player should feel)",
  "target player",
  "core loop",
  "key mechanics",
  "setting and tone",
  "scope and platform",
  "what makes it different",
  "biggest risk or open question",
];

const BATCH_RULE =
  "Ask 3-4 questions per turn with ask_questions (fewer only when fewer branches are open); group questions that " +
  "don't depend on each other; hold dependent ones for the next turn; mark your recommended choice; put any " +
  "background in context, not in the question.";

const SYSTEM_PROMPT = [
  "You are Claude, embedded in Dreamer, a desktop app for collecting and developing game ideas.",
  "Tone: formal, neutral and concise. Answer directly. No exclamation marks, no flattery, no filler, no emoji.",
  "The first message of a session carries the project memory, a short project digest (card counts per " +
    "stage), the current card and [Related cards] (id, title, stage, excerpt) found for that message. Later " +
    "messages carry only what changed and any new related cards. You have no search or list tools. Answer from " +
    "what you were given; read_card (full card by id) or view_attachment (an image or a web clip) may be used " +
    "ONCE per message, and a message allows at most 4 tool calls, so only read when the excerpt is not enough. " +
    "Cite cards by title. Never invent cards: if the related cards do not cover it, say so.",
  "The only things you can create are suggestions the user must accept: create_card makes a ghost card, " +
    "propose_link makes a ghost link, merge_cards makes a ghost merged card, and propose_edit proposes changes to " +
    "an existing card (title, body, tags, stage, captions) that the user keeps or dismisses. When asked to change, " +
    "rewrite or tidy a card, use propose_edit; never claim the card has changed. You have no file, shell, edit or " +
    "delete access, by design.",
  "Project versions: a project can have versions (v1, v2, ...), each a full copy of the design; the context line " +
    "\"Version: v2 (others: v1)\" says which one is open. Everything you read and write is in the open version. " +
    "Read tools take an optional version to look at another one. Write tools take an optional version too, but only " +
    "when the user's message names that version; if a write is refused, ask the user instead of retrying. Project " +
    "memory is shared by all versions.",
  "Project memory: the [Project memory] block is what the user has decided (Decisions and Rejected are " +
    "authoritative; follow them, and never re-suggest a rejected idea). A separate automatic pass keeps it up to " +
    "date after your turns, so do not try to maintain it. Use remember(text, section?) and forget(text) ONLY when " +
    "the user explicitly asks (\"remember ...\", \"forget ...\", \"that's no longer true\"); then confirm in one short sentence.",
  "Web: WebSearch and WebFetch work only on turns where the user switched web access on. If a call is refused, " +
    "say web access is off and that they can turn it on with the globe button; do not retry. Cite the pages you used.",
  "/merge: read each listed card, then call merge_cards exactly once with all their ids and one synthesized " +
    "title and body. Do not call create_card. Then reply with exactly: Proposed a merged card.",
  "/grill-me: interview the user about the selected card with multiple-choice questions, working through " +
    "these items in order and skipping any the card's notes already answer: " +
    GRILL_ITEMS.map((x, i) => `${i + 1}. ${x}`).join("; ") +
    ". " +
    BATCH_RULE +
    " On each turn, call ask_questions exactly once and write NO other text: no preamble, no restating the questions, " +
    "no reaction to the previous answers, no praise or encouragement, no commentary on the options the user chose. " +
    "Questions and options are neutral and specific (2-5 options). Never ask a question listed in [Answered so far] " +
    "again; move to the next open branch, or say the grill is done. The user's answers are recorded in the card's " +
    "notes automatically. When every item has been covered, do not ask another question and do not write a summary " +
    "in chat: call create_card exactly once to propose a spec card with title 'Spec: <card title>', stage 'lucid', " +
    "tags including 'spec', a link to the selected card with label 'spec of', and a markdown body with one short " +
    "section per item, built only from the user's answers and the card's notes. Then reply with exactly: " +
    "Proposed a spec card.",
  "/grill-me handoff: the message lists project gap items (from the handoff gap check) with notes. Interview the " +
    "user about those items only, in the given order, with the same rules as /grill-me (" +
    BATCH_RULE +
    " Call ask_questions once, no other text). On every question set handoff_item to the exact item " +
    "name. Ask one or two questions per item, enough to settle it. The app records each answer on the Tech card " +
    "(for 'platform & tech') or on the 'Project decisions' card. Do not propose cards. When every listed item is " +
    "settled, reply with exactly: Gaps covered. Generate the pack again from Summarize.",
  "/grill-me checklist: the message lists the card's open questions as `[item_id] question — context`. Work through " +
    "them in the given order, 3-4 per turn, calling ask_questions once per turn with no other text: one entry per " +
    "listed item with item_id set to its id, question = the item's question (rephrased only if needed to be " +
    "answerable by a choice), 2-5 concrete choices drawn from the context and the project, recommended set, any " +
    "background in context. Never ask an item that was answered or skipped earlier in the thread. When all are " +
    "asked, reply with exactly: All open questions covered. No cards, no spec.",
  "/related: from the [Related cards] block, call propose_link for the 1-5 strongest connections to the selected card, " +
    "each with a short label and reason, and list them briefly.",
  "'Give me 3 takes': propose three distinctly different create_card calls.",
  "Ghost artifacts: during /grill-me or /expand, when a visual would settle an open question, you may call " +
    "propose_artifact once (type, title, a brief naming the question, source_card = the card). It costs nothing until " +
    "the user keeps it. Never more than one per turn.",
  "/expand: from the selected card in this message, propose 2-4 child ghost cards with create_card, each a concrete next idea " +
    "that grows out of it, each with linked_from set to the card's id and a 2-3 word label. Same stage as the " +
    "card or earlier. Then list them in one line each.",
  "/critique: use the card and the [Related cards] block. Then call create_card exactly once: " +
    "kind 'checklist', title 'Critique: <card title>', items listing its risks, weak spots and open questions " +
    "(question: true where the item is a question), and a link to the card labelled 'critique of'. Then reply " +
    "with one sentence naming the most serious issue.",
  "Organizing (/organize, or any request to group, re-layout, frame, tag or tidy cards): it happens inside the open " +
    "folder only, with frames, layout and tags. Folders are project versions: never create, rename or move folders, " +
    "and never move cards between folders. Call list_tree once, then propose_organize once with the whole plan. Never " +
    "describe changes as done; the user reviews and applies the plan. Group by what the user asked for (by mechanic, " +
    "by stage, core vs side ideas); otherwise by theme, into 3-8 well-named frames. Retag to reuse and merge existing " +
    "tags. Never touch pinned cards' positions. Use the ids from list_tree exactly. If propose_organize returns an " +
    "error, fix the listed ops and call it again. For '/organize revise', the message carries the previous plan: " +
    "propose the whole revised plan. Then reply with one short sentence.",
  "Artifacts: you cannot make images, style guides or mockups in chat. When the user asks for a theme / style " +
    "guide, a character design or sheet, concept art, or an interactive mockup, call escalate_artifact once (type + " +
    "a brief with only what they asked for and the relevant context), then end your turn with one short sentence.",
  "/describe: read_card, call view_attachment on each image, then call propose_edit once with a short, factual " +
    "caption for each image (captions keyed by attachment id) and the card's tags plus up to 4 new ones. Then reply " +
    "with exactly: Proposed captions and tags.",
].join("\n\n");

// ---- Live activity: what Claude is doing during a turn or one-shot job ----
//
// One tracker per turn (or job) turns the SDK stream into protocol events, each sent through `out`
// (which attaches the turn id or job id):
//   {type:"step", step:{sid, kind:"tool"|"thinking", tool?, label, status, startedAt, endedAt?, detail?}}
//   {type:"thinking_delta", sid, text}
//   {type:"usage", input, cacheRead, cacheCreate, output}   -- cumulative for the turn, after every API call
// Only the main agent's events count (parent_tool_use_id null).

const DEFAULT_CONTEXT_WINDOW = 200000;
const shortTool = (name) => String(name || "").replace(/^mcp__.+?__/, "");
const clip = (s, n = 48) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const resultText = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return clip(url, 40);
  }
};

const VERSIONED_WRITES = new Set(["create_card", "propose_edit", "propose_link", "merge_cards", "propose_artifact"]);
/** A short, human label for a tool call. A write into another project version carries its tag ("· v1"). */
function toolLabel(name, input, r) {
  const label = toolLabelBase(name, input, r);
  const v = typeof input?.version === "string" ? input.version.trim() : "";
  return v && VERSIONED_WRITES.has(shortTool(name)) ? `${label} · ${clip(v, 24)}` : label;
}

/** `r` = {text, hasImage} once its result is in (and not an error). */
function toolLabelBase(name, input, r) {
  const a = input ?? {};
  switch (shortTool(name)) {
    case "read_card": {
      const c = r && parseJson(r.text);
      return c?.title ? `Read "${clip(c.title)}"` : "Reading a card";
    }
    case "search_cards": {
      if (!r) return a.query ? `Searching "${clip(a.query)}"` : "Searching cards";
      const hits = parseJson(r.text);
      const n = Array.isArray(hits) ? hits.length : 0;
      return `Searched "${clip(a.query)}" → ${n} card${n === 1 ? "" : "s"}`;
    }
    case "list_related":
      return "Found related cards";
    case "list_cards":
      return "Listed cards";
    case "view_attachment":
      if (!r) return "Looking at an attachment";
      return r.hasImage ? "Looked at an image" : "Read a web clip";
    case "create_card":
    case "create_cards":
      // Every card Claude makes in Dreamer is a ghost suggestion.
      return a.title ? `Suggested "${clip(a.title)}"` : "Suggested a card";
    case "update_card":
      return a.title ? `Edited "${clip(a.title)}"` : "Edited a card";
    case "propose_edit":
      return "Suggested an edit";
    case "propose_link":
      return "Suggested a link";
    case "list_tree":
      return "Read the folder tree";
    case "propose_organize":
      return "Proposed a plan";
    case "merge_cards":
      return "Suggested a merge";
    case "link_cards":
    case "link":
      return "Linked cards";
    case "move_cards":
    case "move":
      return "Moved cards";
    case "frame_cards":
    case "frame":
      return "Framed cards";
    case "trash_card":
    case "trash":
      return "Moved a card to Trash";
    case "ask_question":
    case "ask_questions":
      return "Asked questions";
    case "remember":
    case "forget":
    case "memory_update":
    case "memory_seed":
      return "Updated memory";
    case "report_gaps":
      return "Reported the gaps";
    case "report_progress":
      return clip(a.note || a.step || "Progress", 60);
    case "write_design_doc":
      return a.name ? `Wrote ${a.name}` : "Writing a doc";
    case "WebSearch":
      return a.query ? `Searched the web "${clip(a.query)}"` : "Searching the web";
    case "WebFetch":
      return a.url ? `Opened ${domainOf(a.url)}` : "Opening a page";
    // Claude Code's own tools (build runs).
    case "Bash":
      return a.command ? `$ ${clip(a.command, 80)}` : "Running a command";
    case "Read":
      return a.file_path ? `Read ${clip(a.file_path, 70)}` : "Reading a file";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return a.file_path || a.notebook_path ? `${shortTool(name) === "Write" ? "Wrote" : "Edited"} ${clip(a.file_path || a.notebook_path, 70)}` : "Editing a file";
    case "Glob":
    case "Grep":
      return a.pattern ? `Searched ${clip(a.pattern, 60)}` : "Searching files";
    case "TodoWrite":
      return "Updated the plan";
    default:
      return shortTool(name) || "Tool";
  }
}

const zeroUsage = () => ({ input: 0, cacheRead: 0, cacheCreate: 0, output: 0 });
const fromApiUsage = (u) => ({ input: u?.input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheCreate: u?.cache_creation_input_tokens ?? 0, output: u?.output_tokens ?? 0 });

function makeTracker(out, label = "") {
  const startedAt = Date.now();
  const finished = []; // the turn's earlier API calls: {input, cacheRead, cacheCreate, output} each
  const callList = () => [...finished, ...(cur ? [cur] : [])].map((c) => ({ input: c.input, cacheRead: c.cacheRead, cacheCreate: c.cacheCreate, output: c.output }));
  const steps = new Map(); // sid -> step (plus private input / json fields)
  const blocks = new Map(); // content block index of the current API call -> sid
  let done = zeroUsage(); // API calls finished in this turn
  let cur = null; // the API call in progress (or the last one)
  let thinkN = 0;
  let asked = false; // an ask_question succeeded in this turn
  let realErrors = 0; // tool errors that were not a Dreamer guard (malformed args, unknown tool, a refused request)
  let repaired = false; // a successful call came after a real error
  const usage = () => {
    const c = cur ?? zeroUsage();
    return { input: done.input + c.input, cacheRead: done.cacheRead + c.cacheRead, cacheCreate: done.cacheCreate + c.cacheCreate, output: done.output + c.output };
  };
  const emitStep = (s) => {
    const { input: _i, json: _j, ...pub } = s;
    out({ type: "step", step: pub });
  };
  const emitUsage = () => out({ type: "usage", ...usage(), calls: callList() });
  const logCall = () => {
    if (cur) dlog(`${label} api_call#${finished.length + 1} input=${cur.input} cacheRead=${cur.cacheRead} cacheCreate=${cur.cacheCreate} total_in=${cur.input + cur.cacheRead + cur.cacheCreate} output=${cur.output}`);
  };
  const relabel = (s) => {
    if (s.kind === "tool") s.label = toolLabel(s.tool, s.input);
  };
  return {
    startedAt,
    usage,
    /** The last API call's whole input: what the thread's context holds now. */
    contextTokens: () => (cur ? cur.input + cur.cacheRead + cur.cacheCreate : 0),
    hasUsage: () => !!cur,
    /** Each API call's own token counts, in order. */
    calls: callList,
    /** Tool calls of this turn that came back as errors (malformed input, failed request). */
    toolErrors: () => realErrors,
    /** A successful tool call came after the turn's real tool error (the in-turn repair worked). */
    repaired: () => repaired,
    /** ask_question succeeded in this turn (its result is recorded). */
    asked: () => asked,
    /** Tool calls still running (each keeps its own time limit in the watchdog). */
    running: () => [...steps.values()].filter((s) => s.kind === "tool" && s.status === "running"),
    /** Calls that did the turn's job (a ghost card, a question, a proposal): no local retry after them. */
    actions: () => [...steps.values()].filter((s) => s.kind === "tool" && s.status === "done" && ACTION_TOOLS.has(s.tool)).length,
    /** Every tool call: name, duration, outcome (diagnostics). */
    toolLog: () => [...steps.values()].filter((s) => s.kind === "tool").map((s) => ({ tool: s.tool, status: s.status, ms: (s.endedAt ?? Date.now()) - s.startedAt })),
    on(msg) {
      if (msg.parent_tool_use_id) return;
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "message_start") {
          if (cur) {
            done = usage();
            finished.push(cur);
          }
          cur = fromApiUsage(ev.message?.usage);
          if (process.env.DREAMER_DEBUG_USAGE) dlog(`${label} raw message_start usage ${JSON.stringify(ev.message?.usage)}`);
          blocks.clear();
          emitUsage();
        } else if (ev?.type === "message_delta" && ev.usage) {
          const u = ev.usage;
          if (process.env.DREAMER_DEBUG_USAGE) dlog(`${label} raw message_delta usage ${JSON.stringify(u)} stop=${ev.delta?.stop_reason}`);
          cur = cur ?? zeroUsage();
          if (u.output_tokens != null) cur.output = u.output_tokens;
          if (u.input_tokens) cur.input = u.input_tokens;
          if (u.cache_read_input_tokens) cur.cacheRead = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens) cur.cacheCreate = u.cache_creation_input_tokens;
          if (ev.delta?.stop_reason) logCall();
          emitUsage();
        } else if (ev?.type === "content_block_start") {
          const cb = ev.content_block ?? {};
          if (cb.type === "tool_use" || cb.type === "server_tool_use") {
            const s = { sid: cb.id, kind: "tool", tool: shortTool(cb.name), label: "", status: "running", startedAt: Date.now(), input: {}, json: "", call: finished.length + 1 };
            relabel(s);
            steps.set(s.sid, s);
            blocks.set(ev.index, s.sid);
            emitStep(s);
          } else if (cb.type === "thinking") {
            const s = { sid: `th${++thinkN}`, kind: "thinking", label: "Thinking", status: "running", startedAt: Date.now(), call: finished.length + 1 };
            steps.set(s.sid, s);
            blocks.set(ev.index, s.sid);
            emitStep(s);
          }
        } else if (ev?.type === "content_block_delta") {
          const s = steps.get(blocks.get(ev.index));
          if (!s) return;
          if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) out({ type: "thinking_delta", sid: s.sid, text: ev.delta.thinking });
          else if (ev.delta?.type === "input_json_delta") s.json += ev.delta.partial_json ?? "";
        } else if (ev?.type === "content_block_stop") {
          const s = steps.get(blocks.get(ev.index));
          if (!s) return;
          if (s.kind === "thinking") {
            s.status = "done";
            s.endedAt = Date.now();
            emitStep(s);
          } else if (s.status === "running") {
            const input = parseJson(s.json || "{}");
            if (input && typeof input === "object") s.input = input;
            const before = s.label;
            relabel(s);
            if (s.label !== before) emitStep(s);
          }
        }
      } else if (msg.type === "assistant") {
        // The complete blocks: tool inputs are certain here (the streamed JSON may be cut short).
        for (const b of msg.message?.content ?? []) {
          const s = (b?.type === "tool_use" || b?.type === "server_tool_use") && steps.get(b.id);
          if (s && s.status === "running" && b.input && typeof b.input === "object") {
            s.input = b.input;
            const before = s.label;
            relabel(s);
            if (s.label !== before) emitStep(s);
          }
        }
      } else if (msg.type === "user") {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          const s = steps.get(b.tool_use_id);
          if (!s || s.status !== "running") continue;
          const txt = resultText(b.content);
          dlog(`${label} tool_result ${s.tool} call#${s.call} bytes=${sizeOfContent(b.content)} text=${txt.length}${Array.isArray(b.content) && b.content.some((x) => x?.type === "image") ? " +image" : ""}${b.is_error ? " (error)" : ""}`);
          // Per-call diagnostics: what was asked, what came back, whether a Dreamer guard answered, and where it sits relative to ask_question.
          const guard = GUARD_RE.test(txt);
          const ask = s.tool === "ask_question" || s.tool === "ask_questions";
          const pos = asked ? "after_ask" : ask && !b.is_error ? "ask" : "before_ask";
          dlog(`${label} tool_call #${s.call} name=${s.tool} pos=${pos} guard=${guard ? "yes" : "no"} error=${b.is_error ? "yes" : "no"} args=${JSON.stringify(clip(JSON.stringify(s.input ?? {}), 300))} result=${JSON.stringify(clip(txt, 300))}`);
          if (ask && !b.is_error && !guard) asked = true;
          if (b.is_error && !guard) realErrors++;
          else if (realErrors > 0 && !guard) repaired = true;
          s.status = b.is_error ? "error" : "done";
          s.endedAt = Date.now();
          if (b.is_error) s.detail = clip(txt.replace(/^Error:\s*/, ""), 200);
          else s.label = toolLabel(s.tool, s.input, { text: txt, hasImage: Array.isArray(b.content) && b.content.some((x) => x?.type === "image") });
          emitStep(s);
        }
      }
    },
    /** Closes steps still open when the turn ends. */
    finish(isError) {
      for (const s of steps.values()) {
        if (s.status !== "running") continue;
        s.status = isError ? "error" : "done";
        s.endedAt = Date.now();
        emitStep(s);
      }
    },
  };
}

/** The model's context window from a result's modelUsage, or 200k. */
function contextWindowOf(result) {
  const ws = Object.values(result?.modelUsage ?? {})
    .map((m) => m?.contextWindow)
    .filter((n) => typeof n === "number" && n > 0);
  return ws.length ? Math.max(...ws) : DEFAULT_CONTEXT_WINDOW;
}

// A queue that the stdin reader pushes into and the query's async-iterable prompt pulls from,
// so one long-lived streaming session can carry many chat turns (and survive interrupts).
function makeTurnQueue() {
  const waiting = [];
  const buffered = [];
  const END = Symbol("end");
  let ended = false;
  return {
    push(msg) {
      if (ended) return;
      const w = waiting.shift();
      if (w) w(msg);
      else buffered.push(msg);
    },
    /** Ends the prompt stream, which ends that Claude session. */
    end() {
      ended = true;
      waiting.splice(0).forEach((w) => w(END));
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (ended && !buffered.length) return;
        const next = buffered.length ? buffered.shift() : await new Promise((resolve) => waiting.push(resolve));
        if (next === END) return;
        yield next;
      }
    },
  };
}

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
const sessions = new Map();
let sessionSeq = 0;
/** Threads in a handoff gap interview (ask_questions' handoff_item counts only there). */
const gapThreads = new Set();
/** Threads in a checklist grill (ask_questions' item_id counts only there). */
const checklistThreads = new Set();
const threadOf = (key) => String(key).replace(/#[^#]*$/, "");
/** Claude Code's built-in tools: a local session never offers them (a 9B model hallucinates Write, Bash, Task…). */
const BUILTIN_TOOLS = ["Agent", "Task", "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "Read", "Glob", "Grep", "LS", "NotebookEdit", "NotebookRead", "TodoWrite", "WebFetch", "WebSearch", "ExitPlanMode", "SlashCommand", "Skill", "ListMcpResourcesTool", "ReadMcpResourceTool"];

const WEB_TOOLS = ["WebSearch", "WebFetch"];

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
function killChild(s) {
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
function closeSession(s, why = "close") {
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
    proxyAbort(s.sid);
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
    if (toolName === "WebFetch" && typeof input.url === "string") emit(s.turn?.s === s ? s.turn : null, { type: "web_fetch", url: input.url });
    return { behavior: "allow", updatedInput: input };
  };
}

// ---- Artifact sessions: one per artifact thread, always on Claude ----
// The artifact's own Dreamer tools (artifactTools, defined below) plus SpriteCook's MCP server. Free
// SpriteCook calls are in allowedTools; paid ones pass through artifactGate (the per-turn credit cap).

/** Dreamer's artifact tools (filled in further down; one list so the server and allowedTools agree). */
const artifactSpecs = [];
const ARTIFACT_SYSTEM_PARTS = [
  "You are Claude, embedded in Dreamer, a desktop app for developing game ideas. In this thread you make and " +
    "iterate one visual artifact for the user's game project: a theme (style guide), a character design, a concept " +
    "art piece or an interactive HTML mockup. You do the thinking (briefs, prompts, design notes, HTML); SpriteCook " +
    "makes the images through its tools. Tone: formal, neutral and concise. No exclamation marks, no flattery, no emoji.",
  "Every message starts with an [Artifact] block: the artifact, its versions and files (with SpriteCook asset ids), " +
    "the theme it inherits (palette, fonts, mood, do/don't, art mode, style reference), the SpriteCook project and the " +
    "credit cap. The user's request comes after the --- line.",
  "Files: you have no file system. Every result goes through Dreamer's tools: start_version once per turn before " +
    "anything is saved, save_image for each SpriteCook result you keep (url + asset_id), write_file for notes.md and " +
    "HTML, copy_asset for project sprites. Never overwrite an older version: feedback and regenerations always start a " +
    "new version (mode 'new'); only add-ons (a turnaround, an expression, an animation) use mode 'add'.",
  "SpriteCook project: if the block says there is none yet, call create_project once (named after the Dreamer " +
    "project) and set_spritecook_project with its id. Pass that project_id to every generation, and assign assets you " +
    "keep with assign_assets_to_project when a tool did not do it. Generation tools may return a job: wait with " +
    "check_job_status (wait_seconds up to 60) until it is done, then save_image with the result's sprite_url and asset id.",
  "Themes (the style anchor of the project): a theme is a palette (5-8 named swatches), two fonts, mood words, " +
    "do/don't notes, an art mode (pixel with a pixel size, or hd), a key art image and a SpriteCook private preset. " +
    "Make the key art with generate_game_art, save_image it as key-art.png (role key-art), save_private_preset from it " +
    "(named after the theme), then set_theme with everything including key_art, key_art_asset_id and preset_id. Then " +
    "write index.html: a one-page style guide (swatches with names and hex, type specimens in both fonts, mood, " +
    "do/don't, the art mode) that embeds the key art as <img src=\"key-art.png\">; plain HTML/SVG/CSS, using the " +
    "injected CSS variables (--color-<swatch-name>, --font-heading, --font-body). Without SpriteCook, do everything " +
    "except the key art and preset.",
  "Inheritance: every image you generate for a non-theme artifact uses the theme in the block as its style reference: " +
    "apply the preset's settings (get_preset_settings) and pass the key art asset in style_asset_ids. Generate in the " +
    "block's art mode (the artifact's override wins over the theme's). With no theme, choose a style that fits the cards " +
    "and state it in the notes.",
  "Generate only what was asked for. Make exactly the parts the user specified, nothing extra (no unrequested " +
    "turnarounds, expressions, variants or animations), then call suggest_next with 2-5 next steps. A chip click or a " +
    "follow-up is its own turn.",
  "Character: the base is a hero image (generate_character, or generate_game_art for a single illustration) plus " +
    "notes.md with the design notes: bio, silhouette, palette, personality. Only when asked or from a chip: a turnaround " +
    "(make_rotation_sheet from the hero asset), expressions or poses (generated with the hero asset as reference_asset_id), " +
    "animations (generate_character_animations, then check_character_animation_run until done). Add-ons use start_version " +
    "mode 'add' and land next to the hero.",
  "Concept art: generate_game_art with the theme reference; notes.md says what the piece shows and the open design " +
    "questions it raises.",
  "Mockup: a live, self-contained index.html (inline CSS and JS, no CDN, no network: the sandbox blocks it) showing the " +
    "screen interactively. Use the theme's CSS variables, project sprites via copy_asset (reference them as " +
    "assets/<file>), and, when it helps, a matching SpriteCook UI kit: create_ui_kit or generate_ui_kit_concepts -> " +
    "select_ui_kit_concept -> generate_ui_kit_component_sheets -> extract_ui_kit_components (check its quality_summary " +
    "and fix flagged 9-slice borders) -> finalize_ui_kit; save each component you use as assets/<name>.png and draw " +
    "9-slice parts with CSS border-image using the reported slice insets. notes.md lists what the screen tests.",
  "Iteration: feedback in this thread (\"bigger hat\", \"more rust\") edits from the current version: start_version mode " +
    "'new', then regenerate with the current asset as edit_asset_id (a direct edit) or reference_asset_id (a variation), " +
    "and save the result under the same file name. A new version starts as a copy of the current one, so only replace " +
    "what changes, and update notes.md to say what changed.",
  "Without SpriteCook (the block says NOT configured, or its tools are missing): do every part that needs no image " +
    "(notes, HTML, the theme spec), then say in one sentence that images need a SpriteCook key in Settings. Do not " +
    "pretend an image exists.",
];
const artifactSystem = () => ARTIFACT_SYSTEM_PARTS.join("\n\n");
/** The artifact tools for one session: each call writes into the artifact of the turn that session answers. */
const makeArtifactServer = (s) =>
  createSdkMcpServer({
    name: "dreamer",
    version: "1.0.0",
    tools: artifactSpecs.map((spec) =>
      tool(spec.name, spec.description, spec.schema, async (args) => {
        {
          const lim = turnGate(s, "any");
          if (lim) return lim;
        }
        const call = (name, input, timeoutMs = 20000) => requestTool(`artifact_${name}`, { ...input, turn: s.turn?.id ?? null }, timeoutMs, s.turn);
        try {
          return await spec.run(args, call);
        } catch (e) {
          return fail(e);
        }
      }),
    ),
  });

/** Permission callback of an artifact session: SpriteCook calls only (paid ones count against the cap). */
function artifactGate(s) {
  return async (toolName, input) => {
    const short = toolName.replace(/^mcp__spritecook__/, "");
    if (!toolName.startsWith("mcp__spritecook__") || !SPRITECOOK_TOOLS.includes(short)) {
      return { behavior: "deny", message: `${toolName} is not available in Dreamer.` };
    }
    if (PAID_TOOLS.has(short)) {
      const verdict = await creditCheck(s, short);
      if (!verdict.ok) return { behavior: "deny", message: verdict.message };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

/** Registers an artifact tool; `run(args, call)` asks Rust through `call` (bound to the session's turn). */
const artifactTool = (name, description, schema, run) => {
  artifactSpecs.push({ name, description, schema, run });
};

artifactTool(
  "start_version",
  "Start the version this turn writes into. mode 'new' (default): a new version v<N+1> whose parent is the current one " +
    "(first generation, regenerate, any feedback/edit). mode 'add': add a part to the current version (an add-on such as " +
    "a turnaround, an expression, an animation, next to what is there). Call it once, before saving anything. brief: " +
    "what this version is; prompts: the exact prompts you send to SpriteCook (saved in brief.md).",
  {
    mode: z.enum(["new", "add"]).optional(),
    brief: z.string(),
    prompts: z.array(z.string()).optional(),
  },
  async (a, call) => {
    const r = await call("start_version", a);
    return text(`Writing into v${r.version} (${r.mode}).`);
  },
);

artifactTool(
  "save_image",
  "Download a SpriteCook result into the working version: url = the asset's sprite_url (or spritesheet_url for an " +
    "animation sheet) from the generate / check_job_status / get_asset_metadata result, asset_id = its SpriteCook asset " +
    "id (kept for later edits and references). name: a short file name such as hero.png, turnaround.png, " +
    "expression-angry.png, anim_idle.png, concept.png, key-art.png, or assets/<name>.png for mockup assets.",
  {
    url: z.string(),
    asset_id: z.string().optional(),
    name: z.string(),
    role: z.string().optional().describe("hero, turnaround, expression, pose, animation, concept, key-art, ui-kit, sprite"),
  },
  async (a, call) => {
    const r = await call("save_image", a, 150000);
    return text(`Saved ${r.file} in v${r.version}.`);
  },
);

artifactTool(
  "write_file",
  "Write a text file into the working version: notes.md (the design notes, always), index.html (a mockup or a theme's " +
    "style-guide page), or .css / .js / .svg / .json files it uses. Writing the same name again replaces it within the version.",
  {
    name: z.string(),
    content: z.string(),
    role: z.string().optional().describe("notes, html, style, script"),
  },
  async (a, call) => {
    const r = await call("write_file", a);
    return text(`Wrote ${r.file} in v${r.version}.`);
  },
);

artifactTool(
  "copy_asset",
  "Copy an image of another artifact in this project (a project sprite listed in the artifact block) into this " +
    "mockup's working version as assets/<name>, so the HTML can use it.",
  {
    from_artifact: z.string(),
    file: z.string(),
    name: z.string().optional().describe("new file name, default the same"),
  },
  async (a, call) => {
    const r = await call("copy_asset", a);
    return text(`Copied to ${r.file} in v${r.version}. Reference it as "${r.file}".`);
  },
);

artifactTool(
  "set_spritecook_project",
  "Record the SpriteCook project that mirrors this Dreamer project (after create_project, once per project).",
  { project_id: z.string() },
  async (a, call) => {
    await call("set_spritecook_project", a);
    return text("Recorded.");
  },
);

artifactTool(
  "set_theme",
  "Theme artifacts only: set the theme spec of the working version (only the keys you pass change). palette: named " +
    "swatches; fonts: heading and body, each one of Playfair Display, Nunito (bundled) or a web-safe family (Georgia, " +
    "Times New Roman, Palatino, Garamond, Arial, Helvetica, Verdana, Trebuchet MS, Tahoma, Courier New, Lucida Console, " +
    "Impact); mood words; dos / donts; art_mode (pixel with pixel_size, or hd); key_art = the saved key art file, with " +
    "its SpriteCook asset id; preset_id = the private preset saved from it.",
  {
    palette: z.array(z.object({ name: z.string(), hex: z.string() })).max(16).optional(),
    fonts: z.object({ heading: z.string().optional(), body: z.string().optional() }).optional(),
    mood: z.array(z.string()).max(12).optional(),
    dos: z.array(z.string()).max(12).optional(),
    donts: z.array(z.string()).max(12).optional(),
    art_mode: z.object({ mode: z.enum(["pixel", "hd"]), pixel_size: z.number().int().optional() }).optional(),
    key_art: z.string().optional(),
    key_art_asset_id: z.string().optional(),
    preset_id: z.string().optional(),
  },
  async (a, call) => {
    const r = await call("set_theme", a);
    return text(`Theme spec of v${r.version} saved.`);
  },
);

artifactTool(
  "suggest_next",
  "End every artifact turn with this: 2-5 contextual next steps shown as chips on the card (they replace the previous " +
    "ones). Each: a 1-3 word label, the exact instruction to run when clicked, and the estimated SpriteCook credits. " +
    "Character examples: Turnaround, Angry expression, Animate idle, Rival faction version. Concept examples: Storm " +
    "weather, Night, Abandoned, Other faction's district. Only steps that build on what exists; never repeat one just done.",
  {
    artifact_id: z.string().optional(),
    suggestions: z.array(z.object({ label: z.string().max(40), prompt: z.string(), estCredits: z.number().optional() })).min(2).max(5),
  },
  async (a, call) => {
    await call("suggest_next", { suggestions: a.suggestions });
    return text("Chips set. End the turn with one or two sentences on what you made.");
  },
);

// ---- Credits: auto under a per-turn cap ----
//
// Paid SpriteCook calls run without asking while the turn stays at or under the cap (Settings,
// default 4 paid calls). A call that would go over it pauses the turn: the chat shows "Generate N
// more (~X credits)?" and the call waits for the answer. Animations and UI kits count by the credits
// they report (estimated beforehand from the last one seen), everything else as one call.

const pendingCredit = new Map(); // reqId -> resolve(bool)
/** Credits each counted tool reported last time (the estimate for the next one). */
const lastCredits = new Map();
/** Credits reported per plain image call, for the "~X credits" estimate. */
const seenCredits = { calls: 0, credits: 0 };

const estimateUnits = (tool_) => (CREDIT_COUNTED.has(tool_) ? Math.max(1, lastCredits.get(tool_) ?? 2) : 1);
const perCall = () => (seenCredits.calls ? seenCredits.credits / seenCredits.calls : null);

/** Before a paid call: within the cap -> go; over it -> ask the user and wait. */
async function creditCheck(s, tool_) {
  const c = s.credits ?? (s.credits = { calls: 0, units: 0, spent: 0, jobs: [], allowed: s.artifact?.cap ?? DEFAULT_CREDIT_CAP });
  const est = estimateUnits(tool_);
  if (c.units + est > c.allowed) {
    const more = s.artifact?.cap ?? DEFAULT_CREDIT_CAP;
    const pc = perCall();
    const reqId = `cc${++reqSeq}`;
    const t = s.turn;
    emit(t, { type: "credit_confirm", reqId, tool: tool_, used: c.units, cap: c.allowed, more, estCredits: pc == null ? null : Math.round(pc * more * 10) / 10 });
    dlog(`credit_confirm turn=${t?.id ?? "-"} tool=${tool_} used=${c.units} cap=${c.allowed}`);
    // Waiting for the user: the turn's watchdog pauses until they answer.
    if (t) t.userWait++;
    const ok = await new Promise((resolve) => pendingCredit.set(reqId, resolve));
    if (t) t.userWait--;
    pendingCredit.delete(reqId);
    emit(t, { type: "credit_answered", reqId, allow: ok });
    if (!ok) {
      return {
        ok: false,
        message: "The user declined more paid SpriteCook calls this turn. Generate nothing else: save what you have, write the notes, call suggest_next and end the turn.",
      };
    }
    c.allowed = c.units + more;
  }
  c.units += est;
  c.calls += 1;
  return { ok: true, est };
}

/** Every pending confirm is answered "no" (the turn was stopped). */
function denyPendingCredits() {
  for (const resolve of pendingCredit.values()) resolve(false);
  pendingCredit.clear();
}

/** Credits and job ids a SpriteCook result reports (keys vary by tool; first number found wins). */
function readCredits(obj) {
  let credits = null;
  const jobs = [];
  let progress = null;
  let status = null;
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (credits == null && typeof v === "number" && /^(credits_(used|charged|spent|cost)|cost_credits|credit_cost|credits)$/.test(key)) credits = v;
      else if (typeof v === "string" && /^(job_id|run_id)$/.test(key) && !jobs.includes(v)) jobs.push(v);
      else if (progress == null && typeof v === "number" && key === "progress") progress = v > 1 ? v / 100 : v;
      else if (status == null && typeof v === "string" && key === "status") status = v;
      else if (v && typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(obj, 0);
  return { credits, jobs, progress, status };
}

/**
 * A SpriteCook tool result arrived in an artifact turn: count what it cost, keep its job ids, and
 * show progress on the card (the artifact's running state).
 */
function onSpritecookResult(s, t, name, content, isError) {
  const short = name.replace(/^mcp__spritecook__/, "");
  const txt = resultText(content);
  const info = readCredits(parseJson(txt));
  const c = s.credits;
  if (c) {
    for (const j of info.jobs) if (!c.jobs.includes(j)) c.jobs.push(j);
    if (info.credits != null && !isError && short !== "get_credit_balance") {
      c.spent += info.credits;
      if (CREDIT_COUNTED.has(short)) {
        // Counted by credits: replace the estimate with what it really cost.
        c.units += info.credits - estimateUnits(short);
        lastCredits.set(short, info.credits);
      } else if (PAID_TOOLS.has(short)) {
        seenCredits.calls += 1;
        seenCredits.credits += info.credits;
      }
    }
  }
  const label = isError ? `SpriteCook: ${short} failed` : info.status && info.status !== "completed" && info.status !== "succeeded" ? `SpriteCook: ${info.status.replace(/_/g, " ")}` : `SpriteCook: ${short.replace(/_/g, " ")}`;
  emit(t, { type: "artifact_progress", artifact: s.artifact?.id ?? null, label, progress: info.progress, credits: c?.spent ?? 0 });
}

// ---- A direct MCP call to SpriteCook, without Claude (the chat header's credit balance) ----
async function spritecookCall(name, args = {}) {
  if (!SPRITECOOK.key) throw new Error("no SpriteCook key");
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${SPRITECOOK.key}` };
  let sid = null;
  let n = 0;
  const post = async (method, params, notify = false) => {
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++n, method, params };
    const r = await fetch(SPRITECOOK.url, { method: "POST", headers: { ...headers, ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    sid = r.headers.get("mcp-session-id") ?? sid;
    const t = await r.text();
    if (notify) return null;
    if (!r.ok) throw new Error(`SpriteCook answered HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    const msgs = ct.includes("event-stream")
      ? t.split("\n").filter((l) => l.startsWith("data:")).map((l) => parseJson(l.slice(5).trim())).filter(Boolean)
      : [parseJson(t)];
    const m = msgs.find((x) => x?.id === body.id);
    if (!m) throw new Error("SpriteCook sent no reply");
    if (m.error) throw new Error(m.error.message || "SpriteCook error");
    return m.result;
  };
  try {
    await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dreamer", version: "1.0.0" } });
    await post("notifications/initialized", {}, true);
    const res = await post("tools/call", { name, arguments: args });
    if (res?.isError) throw new Error(resultText(res.content) || "SpriteCook error");
    return res?.structuredContent ?? parseJson(resultText(res?.content)) ?? resultText(res?.content);
  } finally {
    if (sid) fetch(SPRITECOOK.url, { method: "DELETE", headers: { ...headers, "mcp-session-id": sid }, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

async function sendBalance() {
  if (!SPRITECOOK.key) return send({ type: "spritecook_balance", credits: null, error: "no_key" });
  try {
    const r = await spritecookCall("get_credit_balance");
    const credits = typeof r?.total_credits === "number" ? r.total_credits : typeof r?.credits === "number" ? r.credits : null;
    send({ type: "spritecook_balance", credits, tier: r?.tier ?? null, error: credits == null ? "unreadable" : null });
  } catch (e) {
    dlog(`spritecook_balance failed: ${e?.message ?? e}`);
    send({ type: "spritecook_balance", credits: null, error: e?.message ?? String(e) });
  }
}

/** Thinking budget of a "Think" turn. */
const THINK_BUDGET = 4000;
const thinkingOption = (think) => (think ? { type: "enabled", budgetTokens: THINK_BUDGET } : { type: "disabled" });

// ---- The local model's connection: a small rewriting proxy between Claude Code and Ollama ----
//
// Claude Code sends no `thinking` field when thinking is off, `max_tokens: 64000` and no
// temperature (seen in a captured request). Ollama then runs Qwen 3.5 in thinking mode at its
// default temperature 1.0: long hidden reasoning, turns that end with no text, slow answers. Every
// local session talks to Ollama through this proxy, which turns thinking off, caps max_tokens,
// sets sampling for tool use, logs each call's size (never content), and can cut a session's
// connection when its turn stalls (Ollama stops generating when the client goes away).

/** Sampling for tool use with Qwen 3.5 in non-thinking mode (its model card's recommendation). */
const LOCAL_SAMPLING = { temperature: 0.7, top_p: 0.8, top_k: 20 };
const LOCAL_MAX_TOKENS = 8192;
const proxyConns = new Map(); // session sid -> Set of {up, res}
let proxyPort = 0;
let proxySeq = 0;
const proxyServer = createHttpServer(onProxy);
const proxyReady = new Promise((resolve) => {
  proxyServer.on("error", (e) => {
    console.error(`[sidecar] local proxy failed: ${e?.stack ?? e}`);
    resolve();
  });
  proxyServer.listen(0, "127.0.0.1", () => {
    proxyPort = proxyServer.address().port;
    resolve();
  });
});
proxyServer.unref?.();

/** The proxy URL a session's Claude Code uses for `upstream` (Ollama, or a fake server in the harness). */
const proxyUrl = (sid, upstream) => (proxyPort ? `http://127.0.0.1:${proxyPort}/p/${sid}/${Buffer.from(upstream).toString("base64url")}` : upstream);

/** Estimated tokens of a request (chars / 3.5, the same rough rate the diagnostics use). */
const estTokens = (chars) => Math.round(chars / 3.5);

/** "choices: array of strings, 2-5 items (required); question: string (required)" from a JSON schema. */
function schemaHint(schema) {
  const req = new Set(schema?.required ?? []);
  const type = (p) =>
    p?.enum ? `one of ${p.enum.join(" | ")}` : p?.type === "array" ? `array of ${p.items?.type ?? "value"}s${p.minItems != null || p.maxItems != null ? `, ${p.minItems ?? 0}-${p.maxItems ?? "any"} items` : ""}` : (p?.type ?? "value");
  return Object.entries(schema?.properties ?? {})
    .map(([k, p]) => `${k}: ${type(p)}${req.has(k) ? " (required)" : ""}`)
    .join("; ");
}

/**
 * The fix hint for a real failed call of a local model, or null: an unknown tool gets the list of
 * tools it can call, invalid args get the tool's expected args. Guards are not errors, so never here.
 */
function repairHint(name, text, tools) {
  if (!name || !tools.has(name) || /No such tool available/i.test(text)) return `Unknown tool ${name ?? "?"}. Available: ${[...tools.keys()].filter((n) => String(n).startsWith("mcp__dreamer__")).join(", ")}. Call one of these, or answer in text.`;
  if (/InputValidationError|Invalid arguments|invalid_type|validation|-32602|expected/i.test(text)) return `Invalid args for ${name}. Expected: ${schemaHint(tools.get(name).input_schema)}. Call it again once with valid args.`;
  return null;
}

/**
 * One in-turn repair for local models: each failed call (malformed args, unknown tool) goes back to
 * the model with a short fix hint. Rewritten in every request (Claude Code resends the history), so
 * the transcript itself is untouched. Claude turns never pass through this proxy.
 */
function addRepairHints(body) {
  const tools = new Map((body.tools ?? []).map((x) => [x?.name, x]));
  const called = new Map();
  for (const m of body.messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === "tool_use") called.set(b.id, b.name);
      if (b?.type !== "tool_result" || !b.is_error) continue;
      const hint = repairHint(called.get(b.tool_use_id), resultText(b.content), tools);
      if (!hint) continue;
      if (Array.isArray(b.content)) b.content.push({ type: "text", text: hint });
      else b.content = `${b.content ?? ""}\n${hint}`;
    }
  }
}

function tuneLocalRequest(buf, sid) {
  let body;
  try {
    body = JSON.parse(buf.toString("utf8"));
  } catch {
    return buf;
  }
  if (!body || typeof body !== "object") return buf;
  addRepairHints(body);
  body.thinking = { type: "disabled" };
  for (const [k, v] of Object.entries(LOCAL_SAMPLING)) if (body[k] == null) body[k] = v;
  body.max_tokens = Math.min(Number(body.max_tokens) || LOCAL_MAX_TOKENS, LOCAL_MAX_TOKENS);
  const sys = JSON.stringify(body.system ?? "").length;
  const tools = JSON.stringify(body.tools ?? []).length;
  const msgs = JSON.stringify(body.messages ?? []).length;
  const s = [...sessions.values()].find((x) => x.sid === sid);
  const t = s?.turn && !s.turn.ended ? s.turn : null;
  const est = estTokens(sys + tools + msgs);
  if (t) t.diag.maxEstTokens = Math.max(t.diag.maxEstTokens ?? 0, est);
  // How much of the thread the model actually receives: messages in this request, and how many are the user's own words.
  const list = Array.isArray(body.messages) ? body.messages : [];
  const userText = list.filter((m) => m?.role === "user" && (typeof m.content === "string" || (m.content ?? []).some((c) => c?.type === "text"))).length;
  // Anything offered that is not Dreamer's own tool (a Claude Code built-in would show here).
  const foreign = (body.tools ?? []).map((x) => x?.name).filter((n) => n && !String(n).startsWith("mcp__dreamer__"));
  dlog(`local_call session=${sid} turn=${t?.id ?? "-"} est_prompt_tokens=${est} num_ctx=${t?.numCtx ?? "?"} system_chars=${sys} tools_chars=${tools} messages_chars=${msgs} tools=${body.tools?.length ?? 0} messages=${list.length} user_text_messages=${userText} other_tools=${foreign.join(",") || "none"}`);
  // Harness only: keep the last request of each turn, so a test can check what the model saw.
  if (process.env.DREAMER_DUMP_PROMPTS && t) {
    try {
      writeFileSync(join(process.env.DREAMER_DUMP_PROMPTS, `${t.id}.json`), JSON.stringify({ system: body.system, messages: list }));
    } catch {
      /* diagnostics only */
    }
  }
  return Buffer.from(JSON.stringify(body));
}

function onProxy(req, res) {
  const m = /^\/p\/([^/]+)\/([^/]+)(\/.*)?$/.exec(req.url ?? "");
  if (!m) {
    res.writeHead(404).end();
    return;
  }
  const [, sid, enc, rest = "/"] = m;
  let target;
  try {
    target = new URL(rest, Buffer.from(enc, "base64url").toString("utf8"));
  } catch {
    res.writeHead(400).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = Buffer.concat(chunks);
    const isMessages = req.method === "POST" && /^\/v1\/messages(\?|$)/.test(rest);
    if (isMessages) body = tuneLocalRequest(body, sid);
    const headers = { ...req.headers, host: target.host, "content-length": String(body.length) };
    delete headers["accept-encoding"];
    const n = ++proxySeq;
    const t0 = Date.now();
    let bytes = 0;
    let first = 0;
    const up = httpRequest(target, { method: req.method, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.on("data", (c) => {
        if (!first) first = Date.now();
        bytes += c.length;
        res.write(c);
      });
      ur.on("end", () => {
        res.end();
        if (isMessages) dlog(`local_http #${n} session=${sid} status=${ur.statusCode} ttfb_ms=${first ? first - t0 : -1} ms=${Date.now() - t0} bytes=${bytes}`);
      });
      ur.on("error", () => res.destroy());
    });
    up.on("error", (e) => {
      dlog(`local_http #${n} session=${sid} failed after ${Date.now() - t0}ms: ${e?.code ?? e?.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `The local model server did not answer (${e?.code ?? e?.message}).` } }));
      } else res.destroy();
    });
    const conn = { up, res };
    let set = proxyConns.get(sid);
    if (!set) proxyConns.set(sid, (set = new Set()));
    set.add(conn);
    // Claude Code went away (closed, killed): stop the upstream generation too.
    res.on("close", () => {
      set.delete(conn);
      up.destroy();
    });
    up.end(body);
  });
}

/** Cuts every model connection of a session. */
function proxyAbort(sid) {
  const set = proxyConns.get(sid);
  if (!set) return;
  for (const { up, res } of set) {
    up.destroy();
    res.destroy();
  }
  proxyConns.delete(sid);
}

/**
 * Env for a Claude Code process that talks to Ollama instead of Anthropic (Ollama >= 0.14 serves the
 * Anthropic Messages API). Every model alias Claude Code might use for side calls points at the
 * local model, and non-essential traffic is off, so nothing from this process reaches Anthropic.
 * `baseUrl` is the session's proxy URL. Claude Code's own retries are cut to one: a local server
 * that is down or wedged should fail fast, and the turn gets one fresh local retry of its own.
 */
function localEnv(baseUrl, model) {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "ollama",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "1",
    API_TIMEOUT_MS: "300000",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
}

/** Session key: one session per thread and backend (env is fixed per Claude Code process). */
const sessionKey = (thread, backend, escalated) => `${thread}#${backend === "local" ? "local" : escalated ? "claude-x" : "claude"}`;

/** Starts Claude Code ourselves (same command the SDK would run) so a stalled one can be killed by pid. */
const spawner = (s) => (opts) => {
  const child = spawnChild(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  s.child = child;
  child.on("error", (e) => dlog(`child_error session=${s.sid} ${e?.code ?? e?.message}`));
  child.on("exit", (code, sig) => {
    if (!s.closed) dlog(`child_exit session=${s.sid} pid=${child.pid} code=${code} signal=${sig}`);
  });
  return child;
};

/** `local` = {baseUrl, vision} for a local-model session, else null. `artifact` = {id, cap} for an artifact thread. */
function openSession(key, resume, model, think = false, local = null, artifact = null) {
  evictIfNeeded();
  const turns = makeTurnQueue();
  const sid = `s${++sessionSeq}`;
  const s = { sid, key, artifact: artifact ? { ...artifact } : null, local: local ? { ...local } : null, vision: !!local?.vision, q: null, turns, resume: resume || null, model: model || null, think: !!think, web: false, lastUsed: Date.now(), answered: false, pending: null, closed: false, busy: false, turn: null, tracker: null, child: null, sessionId: resume || null };
  const upstream = local ? FAKE_LOCAL_URL || local.baseUrl : null;
  s.q = query({
    prompt: turns,
    options: {
      ...BASE_OPTIONS,
      // Local models get no web tools (WebSearch/WebFetch run server-side at Anthropic) and no
      // thinking budget; a web or Think turn is routed to Claude instead.
      ...(local ? { tools: [], disallowedTools: BUILTIN_TOOLS } : {}),
      thinking: thinkingOption(local ? false : think),
      canUseTool: webGate(s),
      mcpServers: { dreamer: makeServer(s) },
      // Claude Code's own auto-compact is a % of the model's window (~800k+ on a 1M model, i.e. never).
      // Pin the window it computes against to a fixed budget, so it also compacts mid-turn.
      env: {
        ...(local ? localEnv(proxyUrl(sid, upstream), model) : { ...claudeEnv(), CLAUDE_CODE_MAX_RETRIES: "2" }),
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

// ---- Turns ----
//
// One object per chat turn. Everything the sidecar sends about a turn goes through emit(t, ...),
// which drops it once the turn has ended (so a late event of a stopped or stalled turn never lands
// on the next one) and feeds the turn's watchdog. `current` is the turn the UI is waiting for.

let current = null;

/** Watchdog limits: the first model event (a model load plus reading a big context), then between events. */
const FIRST_EVENT_MS = { local: Number(process.env.DREAMER_FIRST_EVENT_LOCAL_MS) || 90000, claude: Number(process.env.DREAMER_FIRST_EVENT_CLAUDE_MS) || 60000 };
const IDLE_MS = Number(process.env.DREAMER_IDLE_MS) || 45000;
/** A running tool keeps its own limit (a SpriteCook generation or a web fetch takes longer than a model pause). */
const toolLimitMs = (name) => (SPRITECOOK_TOOLS.includes(name) ? 300000 : WEB_TOOLS.includes(name) ? 120000 : 60000);
/** Budgets of the steps before the model runs: the thread summary (compaction) and an escalation's recap. */
const SUMMARY_MS = { local: 150000, claude: 120000 };
const RECAP_MS = 60000;
const HEARTBEAT_MS = 10000;
/** Tools whose success means the turn did its job even without text (no local retry after them: no duplicates). */
const ACTION_TOOLS = new Set(["create_card", "ask_question", "ask_questions", "propose_link", "merge_cards", "propose_edit", "propose_organize", "remember", "forget", "escalate_artifact", "propose_artifact"]);

function newTurn(msg, { local, artifact, model }) {
  const now = Date.now();
  return {
    id: msg.id,
    local: !!local,
    artifact: !!artifact,
    model,
    numCtx: Number(msg.local?.numCtx) || null,
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
    attempt: 1,
    limits: makeLimits(msg.text, !!artifact),
    waits: new Map(),
    userWait: 0,
    text: "",
    questionAsked: false,
    visionBlocked: false,
    escalatedArtifact: false,
    pendingFull: null,
    retryFull: null,
    retryModel: null,
    retried: false,
    retriedFrom: null,
    tier: null,
    lastInput: null,
    prepQuery: null,
    diag: { maxEstTokens: 0, sentChars: 0 },
  };
}

const touch = (t) => {
  if (t && !t.ended) t.lastAt = Date.now();
};

/** Sends an event of turn `t` (dropped once it has ended). `fromModel`: model output, which ends the first-event wait. */
function emit(t, obj, fromModel = false) {
  if (!t || t.ended) return false;
  const now = Date.now();
  t.lastAt = now;
  t.lastType = obj.type;
  if (fromModel && !t.firstModelAt && t.phase === "model") t.firstModelAt = now;
  sendRaw({ ...obj, id: t.id });
  return true;
}

/** Binds a turn to the session that answers it. */
function attach(t, s) {
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
        : t.modelStartedAt + (t.local ? FIRST_EVENT_MS.local : FIRST_EVENT_MS.claude);
  for (const until of t.waits.values()) d = Math.max(d, until);
  const tr = t.s?.tracker?.turn === t ? t.s.tracker : null;
  for (const st of tr?.running() ?? []) d = Math.max(d, st.startedAt + toolLimitMs(st.tool));
  return d;
}

const stallWhy = (t) =>
  t.phase === "prep"
    ? "the thread summary took too long"
    : !t.firstModelAt
      ? `no reply from the ${t.local ? "local model" : "model"} within ${Math.round((t.local ? FIRST_EVENT_MS.local : FIRST_EVENT_MS.claude) / 1000)}s`
      : `no activity for ${Math.round(IDLE_MS / 1000)}s`;

// The watchdog: one tick a second over the turn the UI waits for. A heartbeat (not activity) tells
// the app the sidecar itself is alive, so its own watchdog only fires when this process is wedged.
setInterval(() => {
  const t = current;
  if (!t || t.ended) return;
  const now = Date.now();
  if (now > turnDeadline(t)) {
    dlog(`turn_stall turn=${t.id} phase=${t.phase} why="${stallWhy(t)}" last=${t.lastType}@${t.lastAt - t.startedAt}ms`);
    const msg = t.local ? `The local model stopped responding (${stallWhy(t)}).` : `Claude stopped responding (${stallWhy(t)}). Retry to send it again.`;
    failTurn(t, "stalled", msg);
    return;
  }
  if (now - (t.aliveAt ?? t.startedAt) >= HEARTBEAT_MS) {
    t.aliveAt = now;
    sendRaw({ type: "alive", id: t.id, phase: t.phase, idleMs: now - t.lastAt });
  }
}, 1000).unref?.();

/** One diagnostics line per turn: sizes, ids and times only. */
function logTurnEnd(t, reason) {
  const tr = t.s?.tracker?.turn === t ? t.s.tracker : null;
  const tools = (tr?.toolLog() ?? []).map((x) => `${x.tool}:${x.ms}ms:${x.status}`).join(",");
  const ttfe = t.firstModelAt ? t.firstModelAt - t.modelStartedAt : -1;
  dlog(
    `turn_end turn=${t.id} backend=${t.local ? "local" : "claude"} model=${t.model ?? "-"} reason=${reason} attempt=${t.attempt} ` +
      `est_prompt_tokens=${t.diag.maxEstTokens || estTokens(t.diag.sentChars)} num_ctx=${t.numCtx ?? "-"} ttfe_ms=${ttfe} ` +
      `last_event=${t.lastType}@${t.lastAt - t.startedAt}ms dur_ms=${Date.now() - t.startedAt} tools=[${tools}]`,
  );
}

/** Marks a turn over: nothing of it is sent any more. */
function markEnded(t, reason) {
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
 * The turn failed (`reason`: error | empty | stalled | limit). A local turn that has not done
 * anything yet gets ONE automatic retry in a fresh local session; after that (or on Claude) it ends
 * with a clear reason. Never an automatic Claude call: "Retry with Claude" is the user's click.
 */
function failTurn(t, reason, message, { noRetry = false } = {}) {
  if (!t || t.ended) return;
  const s = t.s;
  const tr = s?.tracker?.turn === t ? s.tracker : null;
  // A second real tool error: the model is fine, its call is not. Keep the session and its history.
  const keep = reason === "tool";
  if (s && !s.closed) {
    if (keep) settle(s, t);
    else closeSession(s, reason);
  }
  if (t.local && !noRetry && !keep && t.attempt === 1 && (tr?.actions() ?? 0) === 0 && s) return localRetry(t, reason, s);
  tr?.finish(true);
  const fallback = reason === "stalled" ? "stalled" : reason === "empty" ? "empty" : reason === "limit" || reason === "tool" ? "tool" : "error";
  if (t.local) {
    // The session id goes back too, so the thread's next turn resumes the session that has its history.
    emit(t, { type: "message_done", text: message, isError: true, backend: "local", model: t.model ?? undefined, fallback, endReason: reason, attempt: t.attempt, ...(s?.sessionId && t.attempt === 1 ? { sessionId: s.sessionId } : {}), ...(t.attempt > 1 ? { localRetried: true } : {}), durationMs: Date.now() - t.startedAt });
  } else {
    emit(t, { type: "error", message, endReason: reason });
  }
  markEnded(t, reason);
}

/** Stops what a session generates for turn `t` but keeps the session; one that does not settle is closed. */
function settle(s, t) {
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

/** A local turn's second real tool error (malformed args, unknown tool) fails it: one repair per turn. */
function checkRepairs(s, t) {
  const tr = s.tracker?.turn === t ? s.tracker : null;
  if (t.local && !t.ended && (tr?.toolErrors() ?? 0) >= 2) failTurn(t, "tool", "The local model made two invalid tool calls in a row.");
}

const RETRY_LABEL = { error: "it failed", empty: "it came back empty", stalled: "it stopped responding", limit: "it looped on tools" };

/** The local turn's one automatic retry: a fresh session (no resume), the full context plus the last messages. */
function localRetry(t, reason, old) {
  dlog(`local_retry turn=${t.id} reason=${reason} after_ms=${Date.now() - t.startedAt}`);
  t.attempt = 2;
  t.text = "";
  t.questionAsked = false;
  t.visionBlocked = false;
  t.waits.clear();
  t.limits = makeLimits(t.userText, false);
  t.phase = "model";
  t.modelStartedAt = Date.now();
  t.firstModelAt = 0;
  emit(t, { type: "text_reset" });
  const at = Date.now();
  emit(t, { type: "step", step: { sid: "local_retry", kind: "tool", tool: "local_retry", label: `Retried locally in a fresh session (${RETRY_LABEL[reason] ?? reason})`, status: "done", startedAt: at, endedAt: at } });
  emit(t, { type: "model_note", model: t.model, localRetry: true, reason });
  let s;
  try {
    s = openSession(old.key, null, old.model, false, old.local, null);
  } catch (e) {
    return failTurn(t, "error", `The local model could not start again: ${e?.message ?? e}`, { noRetry: true });
  }
  s.web = false;
  s.escalated = false;
  attach(t, s);
  const replay = t.retryFull ?? t.pendingFull;
  s.pending = replay;
  s.turns.push(replay);
}

/** A saved session that can't be resumed (deleted, expired): start the thread afresh and replay the turn. */
function restartFresh(s) {
  const t = s.turn;
  dlog(`session_restart session=${s.sid} key=${s.key} turn=${t?.id ?? "-"} why=resume_failed`);
  closeSession(s);
  if (!t || t.ended || t.s !== s) return;
  let fresh;
  try {
    fresh = openSession(s.key, null, s.model, s.think, s.local, s.artifact);
  } catch (e) {
    console.error(`[sidecar] could not start a fresh session after a failed resume: ${e?.stack ?? e}`);
    return failTurn(t, "error", `Claude could not start a new session: ${e?.message ?? e}`, { noRetry: true });
  }
  fresh.web = s.web;
  fresh.escalated = s.escalated;
  attach(t, fresh);
  // A fresh session knows nothing: replay the waiting turn with the full context (local: plus the
  // thread's visible history, the same text the automatic local retry gets).
  dlog(`session_restart_replay turn=${t.id} sent=${s.local && t.retryFull ? "retryText" : "fullText"}`);
  const replay = (s.local ? t.retryFull : null) ?? t.pendingFull ?? s.pending;
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

/** Why a local turn needs "Retry with Claude", or null when it went fine. */
function localFallback(t, msg, text, tr) {
  if (!t.local) return null;
  if (msg.is_error) return "error";
  if (t.visionBlocked) return "vision";
  const errors = tr?.toolErrors() ?? 0;
  if (errors >= 2 || (errors === 1 && !tr.repaired())) return "tool";
  if (!t.questionAsked && !String(text ?? "").trim() && (tr?.actions() ?? 0) === 0) return "empty";
  return null;
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
  const fallback = localFallback(t, msg, text, tr);
  // A local error or empty reply that did nothing yet: one fresh local retry.
  if (t.local && (fallback === "error" || fallback === "empty") && t.attempt === 1 && (tr?.actions() ?? 0) === 0) {
    return failTurn(t, fallback, "");
  }
  tr?.finish(msg.is_error);
  const usage = tr?.hasUsage() ? tr.usage() : fromApiUsage(msg.usage);
  dlog(`turn_done turn=${t.id} calls=${msg.num_turns} sum_input=${usage.input} sum_cacheRead=${usage.cacheRead} sum_cacheCreate=${usage.cacheCreate} output=${usage.output} lastCallContext=${tr?.contextTokens?.() ?? 0} answerChars=${String(text).length}`);
  const u = msg.usage ?? {};
  const contextTokens = (tr?.hasUsage() && tr.contextTokens()) || t.lastInput || (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  if (fallback) dlog(`local_fallback turn=${t.id} reason=${fallback}`);
  const endReason = msg.is_error ? "error" : fallback === "empty" ? "empty" : "done";
  const failedText = t.local && msg.is_error && !String(text ?? "").trim() ? `The local model failed${t.attempt > 1 ? " twice" : ""}${msg.subtype && msg.subtype !== "success" ? ` (${msg.subtype})` : ""}.` : text;
  emit(t, {
    type: "message_done",
    text: failedText,
    sessionId: msg.session_id,
    isError: msg.is_error,
    inputTokens: contextTokens,
    usage: { ...usage, ...(tr?.hasUsage() ? { calls: tr.calls() } : {}) },
    durationMs: Date.now() - t.startedAt,
    // The model this turn was routed to. modelUsage also lists Claude Code's own cheap
    // background calls (Haiku), so its first key is not reliably the answering model.
    model: s.model || Object.keys(msg.modelUsage ?? {})[0] || undefined,
    tier: t.tier ?? undefined,
    backend: s.local ? "local" : "claude",
    ...(s.escalated ? { escalated: true } : {}),
    ...(fallback ? { fallback } : {}),
    endReason,
    attempt: t.attempt,
    ...(t.attempt > 1 ? { localRetried: true } : {}),
    ...(s.artifact ? { artifact: { id: s.artifact.id, credits: s.credits?.spent ?? 0, paidCalls: s.credits?.calls ?? 0, jobs: s.credits?.jobs ?? [], spritecook: s.spritecookOk !== false } } : {}),
    ...(t.retried ? { retried: true, retriedFrom: t.retriedFrom } : {}),
    contextTokens,
    contextWindow: contextWindowOf(msg),
  });
  markEnded(t, endReason);
  s.web = false;
  // An escalation is one turn: its session is not resumed, the thread goes back to local.
  if (s.escalated) closeSession(s);
}

function pump(s) {
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
          else if (msg.type === "user") checkRepairs(s, t);
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
          failTurn(t, "error", t.local ? "The local model's session stopped without answering." : "Claude Code stopped without answering. Retry to start a new session.");
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
    if (t && !t.ended) failTurn(t, "error", `Claude stopped unexpectedly: ${e?.message ?? e}`, { noRetry: true });
  });
}

// ---- One-shot handoff sessions (the project handoff pack) ----
//
// Separate from the chat threads: each run is its own query() with the export model, a custom
// system prompt and read-only tools that Rust answers for the job's scope (handoff.rs). Claude has
// no file access here: docs go to write_design_doc and Rust writes them only when the run succeeds.

const HANDOFF_BASE = [
  "You are Claude, embedded in Dreamer, a desktop app for developing game ideas. You are running a one-shot, " +
    "non-interactive job on one project. Nobody reads your chat text; only your tool calls matter. Tone of " +
    "everything you write: formal, neutral, concise. No exclamation marks, no flattery, no emoji.",
  "Tools: list_cards lists the cards in scope (id, kind, title, stage, role, frame, unconfirmed, image and clip " +
    "counts); read_card returns one card in full (body, fields, checklist items, links, attachments with their " +
    "asset file names); view_attachment shows an image or returns a web clip's saved text. Only cards in scope can " +
    "be read. Stage order: Mist (raw, unconfirmed) < Reverie < Lucid < Dream (settled) < Built (already built in the repo; list_cards says whether it is built, partly built or needs a rebuild because its design changed since). The card with role 'tech' " +
    "is the Tech & constraints card; role 'decisions' is the Project decisions card (answers the user gave to " +
    "close gaps; treat them as settled). When the task message includes the project memory (memory.md), it is a " +
    "primary source: its Decisions and Rejected lines are the user's own confirmed choices and are authoritative over " +
    "Mist cards; a rejected idea is never a feature.",
];

const GAP_SYSTEM = [
  ...HANDOFF_BASE,
  "Job: gap check before the design docs are written. Read every card in scope with read_card (look at images " +
    "only when a card's text depends on them). Then judge each checklist item from the task message: 'ok' = clearly " +
    "decided in the cards; 'thin' = mentioned but vague, contradictory, or only in unconfirmed Mist cards; " +
    "'missing' = not covered. 'platform & tech' is judged mainly from the Tech card. 'monetization' is ok when the " +
    "cards say there is none. Call report_gaps exactly once, with one entry per checklist item, in order, using " +
    "the exact item names; each note is one short sentence saying what is there or what is needed. Then end with " +
    "one short sentence. Do not invent anything the cards do not say.",
].join("\n\n");

const GEN_SYSTEM = [
  ...HANDOFF_BASE,
  "Job: write the handoff pack, the design docs Claude Code will build the game from. Work in this order: " +
    "list_cards; read_card on every card in scope; view_attachment on every image (and every clip that has an " +
    "excerpt); then write each doc with write_design_doc(name, markdown), one call per file. Call report_progress " +
    "with a short note when you move to a new phase. Use only these file names: 00-overview.md, 01-gdd.md, " +
    "02-tech-design.md, 03-roadmap.md, 04-open-questions.md, 05-assets.md, CLAUDE.md, CHANGELOG.md.",
  "Source of truth: the cards in scope. Never invent features, mechanics, numbers or story. Mist cards are " +
    "unconfirmed: never present them as decisions; collect them in a section 'Ideas under consideration' (in " +
    "01-gdd.md, or the doc they fit best). Anything undecided, and every gap listed in the task message, becomes an " +
    "explicit 'TBD:' item where it belongs and is listed in 04-open-questions.md (question, why it matters, which " +
    "cards touch it). When cards contradict each other, say so and list it as an open question.",
  "00-overview.md: one page: the pitch in two sentences, core experience, target player, pillars, what makes it " +
    "different, a short table of contents of the other docs. 01-gdd.md: the game design document. Use the frame " +
    "names as grouping hints for its sections, but reorganize when a clearer structure exists (core loop, " +
    "mechanics, progression, setting & tone, art direction, audio direction, UI, content). Cite card titles in " +
    "parentheses where a section rests on a card. A Built card is an existing feature: describe it as such and " +
    "mark it 'Built' (or 'Built, needs rebuild' / 'Partly built' as list_cards says).",
  "Images: every image in scope must appear in the most relevant doc, embedded exactly as " +
    "![caption](assets/<file>) using the asset file name read_card gave, followed by 1-2 sentences on what it " +
    "shows and why it matters for the design (based on what you saw, not only the caption). Web clips: in " +
    "05-assets.md under 'References', each with title, URL, caption and a two-line takeaway from its excerpt; also " +
    "mention them inline where relevant. 05-assets.md also lists every image (file, card, description) and the " +
    "assets the game will need, as far as the cards say.",
  "02-tech-design.md comes from the Tech & constraints card (and any tech-related cards): architecture, modules, " +
    "data, platform constraints, testing approach. Where the Tech card is silent, write TBD; do not choose an " +
    "engine or stack the cards do not name.",
  "03-roadmap.md: milestone M1 = a playable prototype of the core loop; then vertical-slice milestones (M2, M3, " +
    "...). Each milestone is a list of tasks. Each task: '- [ ] M1-T3: <goal>', then indented lines: 'Acceptance:' " +
    "(checkable criteria), 'Relies on:' (doc#section references, e.g. 01-gdd.md#core-loop), 'Size: one Claude Code " +
    "session'. Tasks are small enough for one session each and ordered so each builds on the previous ones. " +
    "Cards that are already Built are existing features: do not plan tasks for them. Exception: a card marked " +
    "'needs rebuild' (its design changed after it was built) or 'partly built' becomes a change task that says what " +
    "differs, with its card id in the task text.",
  "CLAUDE.md: under 60 lines. What the project is (2 lines). Where the docs are: docs/design/ (list the files). " +
    "Build order: follow docs/design/03-roadmap.md task by task, starting at the first unchecked task, and check it " +
    "off when done. Rules: do not invent design; when a design question blocks you, append it to " +
    "docs/design/QUESTIONS.md as '- [ ] Q (task id): question — context', pick the most conservative option and " +
    "continue; commit once per task with the task id in the message. Build status: after finishing work for a card, " +
    "update docs/design/STATUS.md (keep its first two lines; one '## <card id> · <title>' section per card with " +
    "'status: in-progress|built|partial|blocked', and where they apply 'task:', 'commits:', 'files:' (repo-relative), " +
    "'evidence:' and a one-line 'notes:'; take card ids from the task file or .dreamer/link.json). A feature you build " +
    "that has no card goes in as '## new · <title>' with status, files and a note on what it is and why it was added. " +
    "Put screenshots and GIFs you produce in docs/design/evidence/. When a commit belongs to exactly one card, start " +
    "its message with [dreamer:<card id>].",
  "CHANGELOG.md: follow the task message (first version: a '## v1' section saying 'Initial version').",
  "Write complete documents in clean Markdown (headings, lists, tables where useful). When every file is written, " +
    "end your turn with one short sentence.",
].join("\n\n");

const TASK_SYSTEM = [
  ...HANDOFF_BASE,
  "Job: write a build task for Claude Code from the cards in scope. list_cards tells which cards to build " +
    "('task_role: build') and which are only context ('context, not to build'): read the context cards, but never " +
    "list them as work; say in the task only what they mean for the cards to build. read_design_doc(name) returns a " +
    "doc of the latest design revision of the open version, when there is one; use it to align with decisions, " +
    "never to add scope. Read every card to build with read_card and look at every image (view_attachment). Then " +
    "call write_task(markdown, meta) exactly once, and end with one short sentence.",
  "Source of truth: the cards. Never invent features, mechanics, numbers or story. The task must stand alone: " +
    "Claude Code reads only this file, the repo's CLAUDE.md and docs/design/. Sections, in this order, as '## ' headings: " +
    "1. Goal (2-3 lines). 2. Context: pointers to the repo's CLAUDE.md and docs/design/ files, only those the task " +
    "message says exist. 3. What to build: one '### <card title> (<card id>)' subsection per card: what it is, the " +
    "behaviour, edge cases, assets referenced (embed none; name the files as read_card gave them). 4. Acceptance " +
    "criteria: checkable bullets per card. 5. Out of scope. 6. Report back: update docs/design/STATUS.md (keep its " +
    "first two lines; one '## <card id> · <title>' section per card with 'status: in-progress|built|partial|blocked', " +
    "and 'task:', 'commits:', 'files:' (repo-relative), 'evidence:', a one-line 'notes:'); append design questions to " +
    "docs/design/QUESTIONS.md as '- [ ] Q (task id): question — context', take the most conservative option and " +
    "continue; commit once per logical step with '[dreamer:<card id>]' at the start of the message when the commit " +
    "belongs to one card. Do not invent design.",
  "Rebuild cards: the task message lists a placeholder like {{DIFF:<card id>}} per rebuild card. Put each on its own " +
    "line, exactly as given, under a 'Design change since last build' heading inside that card's subsection of " +
    "'What to build'. Never write the diff yourself. Write the change task around it (what differs, what to keep) and " +
    "list the files from the card's build.files as the likely places to change.",
  "Flags: in meta.flags, list each thin spot: a card for which no acceptance criteria can be written, cards that " +
    "contradict each other, an asset a card refers to that is missing. { card_id?, text } with one short sentence; " +
    "card_id only when it is one card. An empty list is fine; do not pad it. meta.title: a short imperative title. " +
    "meta.card_ids: exactly the cards to build. Tone: formal, neutral, concise; no emoji.",
].join("\n\n");

const oneshots = new Map();

function imageResult(args, r) {
  if (r.kind === "image") {
    return {
      content: [
        { type: "text", text: `Image ${args.attachment_id}${r.caption ? ` (caption: ${r.caption})` : " (no caption)"}:` },
        { type: "image", data: r.data, mimeType: r.mime },
      ],
    };
  }
  const head = `Web clip ${args.attachment_id}: ${r.title ? `"${r.title}" ` : ""}<${r.url}>${r.caption ? ` (caption: ${r.caption})` : ""}`;
  return text(`${head}\n\n${r.text}`);
}

function handoffTools(job, mode) {
  const call = (name, input) => requestTool(`handoff_${name}`, { ...input, job });
  const wrap = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
  const tools = [
    tool("list_cards", "List the cards in this job's scope.", {}, wrap(async () => text(await call("list_cards", {})))),
    tool("read_card", "Read one card in scope in full.", { id: z.string() }, wrap(async (a) => text(await call("read_card", { id: a.id })))),
    tool(
      "view_attachment",
      "Look at an image attachment (returned as an image) or read a web clip's saved text.",
      { card_id: z.string(), attachment_id: z.string() },
      wrap(async (a) => imageResult(a, await call("view_attachment", a))),
    ),
  ];
  if (mode === "task") {
    tools.push(
      tool("read_design_doc", "Read one doc of the latest design revision of the open version (e.g. 01-gdd.md), if there is one.", { name: z.string() }, wrap(async (a) => text(await call("read_design_doc", a)))),
      tool(
        "write_task",
        "Save the finished task, once. markdown is the whole task; meta lists its title, the cards it builds and the thin spots.",
        {
          markdown: z.string(),
          meta: z.object({
            title: z.string(),
            card_ids: z.array(z.string()),
            flags: z.array(z.object({ card_id: z.string().optional(), text: z.string() })),
          }),
        },
        wrap(async (a) => text(await call("write_task", a))),
      ),
    );
  } else if (mode === "gaps") {
    tools.push(
      tool(
        "report_gaps",
        "Report the gap check result, once: one entry per checklist item.",
        { gaps: z.array(z.object({ item: z.string(), status: z.enum(["ok", "thin", "missing"]), note: z.string() })) },
        wrap(async (a) => text(await call("report_gaps", a))),
      ),
    );
  } else {
    tools.push(
      tool(
        "report_progress",
        "Tell the user which phase you are in (shown in the progress panel).",
        { step: z.string().describe("e.g. reading, viewing images, writing 01-gdd.md"), note: z.string() },
        wrap(async (a) => text(await call("report_progress", a))),
      ),
      tool(
        "write_design_doc",
        "Save one design doc. name must be one of: 00-overview.md, 01-gdd.md, 02-tech-design.md, 03-roadmap.md, " +
          "04-open-questions.md, 05-assets.md, CLAUDE.md, CHANGELOG.md. Writing the same name again replaces it.",
        { name: z.string(), markdown: z.string() },
        wrap(async (a) => text(await call("write_design_doc", a))),
      ),
    );
  }
  return tools;
}

function startOneshot(msg) {
  const { job, mode, prompt } = msg;
  const model = typeof msg.model === "string" && msg.model ? msg.model : null;
  const tools = handoffTools(job, mode);
  const turns = makeTurnQueue();
  const entry = { q: null, turns, cancelled: false };
  oneshots.set(job, entry);
  entry.q = query({
    prompt: turns,
    options: {
      systemPrompt: { type: "custom", prompt: mode === "gaps" ? GAP_SYSTEM : mode === "task" ? TASK_SYSTEM : GEN_SYSTEM },
      allowedTools: tools.map((t) => `mcp__handoff__${t.name}`),
      // No built-in tools at all (no files, shell or web), and the user's own settings are ignored.
      // Every tool offered is in allowedTools, so no permission callback is needed.
      tools: [],
      permissionMode: "default",
      settingSources: [],
      mcpServers: { handoff: createSdkMcpServer({ name: "handoff", version: "1.0.0", tools }) },
      includePartialMessages: true,
      ...(model ? { model } : {}),
    },
  });
  // One turn: the queue stays open until the result arrives (SDK MCP tools need streaming input).
  turns.push({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
  const tracker = makeTracker((o) => !entry.cancelled && send({ ...o, job }));
  (async () => {
    let done = null;
    try {
      for await (const m of entry.q) {
        tracker.on(m);
        if (m.type === "result") {
          tracker.finish(m.is_error);
          done =
            m.subtype === "success" && !m.is_error
              ? { ok: true }
              : { ok: false, error: `Claude could not finish (${m.subtype}${m.is_error && m.result ? `: ${m.result}` : ""}).` };
          turns.end();
        }
      }
    } catch (e) {
      if (!done) done = { ok: false, error: e?.message ?? String(e) };
    }
    oneshots.delete(job);
    if (entry.cancelled) done = { ok: false, cancelled: true, error: "Cancelled." };
    send({ type: "oneshot_done", job, ...(done ?? { ok: false, error: "Claude stopped without a result." }) });
  })();
}

function cancelOneshot(job) {
  const entry = oneshots.get(job);
  if (!entry) return;
  entry.cancelled = true;
  entry.q.interrupt?.().catch(() => {});
  entry.turns.end();
  try {
    entry.q.close?.();
  } catch {
    /* already gone */
  }
}

// ---- Repo scan: one query in the linked repo (Read, Glob, Grep only) that ends in one emit_bundle ----

const SCAN_SYSTEM = [
  "You scan a code repository (your working directory) for Dreamer, a game-design idea app, and report what is " +
    "ALREADY BUILT as cards in one .dreamer.md bundle. You can only Read, Glob and Grep. Skip .git, node_modules, " +
    "build/, dist/, Library/, Intermediate/, Binaries/, .vs/ and third-party or vendor folders. Start with list_cards " +
    "(the cards Dreamer already has, and its tags), then look at the repo (README, manifests, top-level layout, then the " +
    "code that implements each feature). Call report_progress(note) now and then with a few words on what you are on. " +
    "When done, call emit_bundle(markdown) exactly once, then end with one short sentence.",
  "Find user-facing features and core systems, not files or classes: 'Harpoon dash', not 'PlayerController.cpp'. One card " +
    "per feature. Every card has stage built and a build block. Never invent: the body says what exists and how it " +
    "behaves, taken from the code. No plans, no ideas, no guesses; if you are unsure what something does, leave it out or " +
    "mark the build status partial and say what is missing in build.notes. Titles are concrete and at most 60 characters.",
  "If an existing card (from list_cards) describes the same feature, put its id in the card's id key: Dreamer shows " +
    "it as an update proposal that adds the build info. Otherwise leave id out. Reuse the existing tags (lowercase, at " +
    "most 4 per card). Put each card in a frame named for its area (the frame key), for example Combat, Fishing, UI.",
  "Format (nothing before or after it):\n---\ndreamer_bundle: 1\nbundle_id: scan-<yyyy-mm-dd>\ntitle: Repo scan\n" +
    "source: dreamer-scan\ncreated: <ISO time>\n---\n<!-- card -->\n---\nref: <unique-kebab-case>\nid: <existing card id, " +
    "only to update>\ntitle: <title>\nstage: built\ntags: [a, b]\nframe: <Area>\nbuild:\n  status: built | partial\n  " +
    "files: [<1-5 main repo-relative files>]\n  notes: <one line>\n---\n<markdown body>\n<!-- card -->\n...\n" +
    "Never put <!-- card --> inside a body. Keep the card count within the limit you are given: when there are more " +
    "features, keep the most important and merge small ones.",
].join("\n\n");

function scanTools(job) {
  const call = (name, input) => requestTool(`scan_${name}`, { ...input, job });
  const wrap = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
  return [
    tool("list_cards", "The cards Dreamer already has in the open version (id, title, stage, tags, frame) and every tag in use.", {}, wrap(async () => text(await call("list_cards", {})))),
    tool("report_progress", "Tell the user what you are on (a few words, shown in the progress panel).", { note: z.string() }, wrap(async (a) => text(await call("report_progress", a)))),
    tool("emit_bundle", "Hand over the finished bundle, once. A rejected bundle comes back with what to fix.", { markdown: z.string() }, wrap(async (a) => text(await call("emit_bundle", a)))),
  ];
}

function startScan(msg) {
  const { job, cwd, prompt } = msg;
  const model = typeof msg.model === "string" && msg.model ? msg.model : null;
  const tools = scanTools(job);
  const turns = makeTurnQueue();
  const entry = { q: null, turns, cancelled: false };
  oneshots.set(job, entry);
  try {
    entry.q = query({
      prompt: turns,
      options: {
        cwd,
        systemPrompt: { type: "custom", prompt: SCAN_SYSTEM },
        // Only these built-in tools exist; Rust's scan_permission also keeps them inside the repo.
        tools: ["Read", "Glob", "Grep"],
        allowedTools: tools.map((t) => `mcp__scan__${t.name}`),
        canUseTool: async (toolName, input) => {
          try {
            const r = await requestTool("scan_permission", { job, tool: toolName, input }, 15000);
            return r?.behavior === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: r?.message || "Denied." };
          } catch (e) {
            return { behavior: "deny", message: `Dreamer could not check this tool call (${e?.message ?? e}).` };
          }
        },
        permissionMode: "default",
        settingSources: [],
        maxTurns: 200,
        mcpServers: { scan: createSdkMcpServer({ name: "scan", version: "1.0.0", tools }) },
        includePartialMessages: true,
        ...(model ? { model } : {}),
      },
    });
  } catch (e) {
    oneshots.delete(job);
    send({ type: "scan_done", job, ok: false, error: `Claude could not start: ${e?.message ?? e}` });
    return;
  }
  turns.push({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
  const tracker = makeTracker((o) => !entry.cancelled && o.type === "step" && send({ type: "scan_step", job, step: o.step }));
  (async () => {
    let done = null;
    try {
      for await (const m of entry.q) {
        tracker.on(m);
        if (m.type === "result") {
          tracker.finish(m.is_error);
          done = m.subtype === "success" && !m.is_error ? { ok: true } : { ok: false, error: `Claude could not finish the scan (${m.subtype}${m.is_error && m.result ? `: ${m.result}` : ""}).` };
          turns.end();
        }
      }
    } catch (e) {
      if (!done) done = { ok: false, error: e?.message ?? String(e) };
    }
    oneshots.delete(job);
    if (entry.cancelled) done = { ok: false, cancelled: true, error: "Cancelled." };
    send({ type: "scan_done", job, ...(done ?? { ok: false, error: "Claude stopped without a result." }) });
  })();
}

// ---- Build runs: Claude Code works on a saved task inside the repo ----
//
// Its own query() per task: cwd = the repo, the claude_code system prompt and the repo's project
// settings (CLAUDE.md, .claude/), the build model. Every tool call is gated by Rust: a PreToolUse
// hook applies the always-deny rules before any settings rule can allow a call; canUseTool asks
// Rust for the rest (auto-allow, or the user's answer in the Build panel). Own watchdog.

const BUILD_LIMITS = {
  first: Number(process.env.DREAMER_BUILD_FIRST_MS) || 120000,
  idle: Number(process.env.DREAMER_BUILD_IDLE_MS) || 90000,
  tool: Number(process.env.DREAMER_BUILD_TOOL_MS) || 600000,
};
/** A permission ask waits for the user as long as it takes (the watchdog pauses meanwhile). */
const ASK_WAIT_MS = 7 * 24 * 3600 * 1000;
const builds = new Map();

function buildGate(run, entry, phase) {
  return async (toolName, input) => {
    entry.asking++;
    try {
      return await requestTool("build_permission", { run, tool: toolName, input, phase }, phase === "hook" ? 15000 : ASK_WAIT_MS);
    } catch (e) {
      return { behavior: "deny", message: `Dreamer could not check this tool call (${e?.message ?? e}).` };
    } finally {
      entry.asking--;
      entry.lastAt = Date.now();
    }
  };
}

function startBuild(msg) {
  const { run, cwd, prompt } = msg;
  const model = typeof msg.model === "string" && msg.model ? msg.model : "sonnet";
  const turns = makeTurnQueue();
  const entry = { q: null, turns, child: null, sid: `b${run}`, startedAt: Date.now(), lastAt: Date.now(), first: false, asking: 0, ended: false, cancelled: false };
  builds.set(run, entry);
  const out = (o) => {
    if (entry.ended) return;
    entry.lastAt = Date.now();
    const { type, ...rest } = o;
    if (type === "step") send({ type: "build_step", run, step: rest.step });
    else if (type === "usage") send({ type: "build_usage", run, ...rest });
  };
  const tracker = makeTracker(out, `build=${run}`);
  const ask = buildGate(run, entry, "ask");
  const hook = buildGate(run, entry, "hook");
  const end = (r) => {
    if (entry.ended) return;
    entry.ended = true;
    clearInterval(entry.timer);
    builds.delete(run);
    dlog(`build_end run=${run} ok=${!!r.ok} dur_ms=${Date.now() - entry.startedAt} tools=[${tracker.toolLog().map((x) => `${x.tool}:${x.ms}ms:${x.status}`).join(",")}]`);
    send({ type: "build_done", run, ...r });
  };
  try {
    entry.q = query({
      prompt: turns,
      options: {
        cwd,
        model,
        systemPrompt: { type: "preset", preset: "claude_code" },
        // The repo's own settings and CLAUDE.md; not the user's global ones.
        settingSources: ["project", "local"],
        permissionMode: "default",
        canUseTool: async (toolName, input) => {
          const r = await ask(toolName, input);
          return r?.behavior === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: r?.message || "Denied." };
        },
        hooks: {
          PreToolUse: [
            {
              onFailure: "block",
              hooks: [
                async (h) => {
                  const r = await hook(h.tool_name, h.tool_input);
                  return r?.behavior === "deny" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.message } } : {};
                },
              ],
            },
          ],
        },
        includePartialMessages: true,
        env: { ...claudeEnv(), CLAUDE_CODE_MAX_RETRIES: "2", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        spawnClaudeCodeProcess: (opts) => spawner(entry)(opts),
      },
    });
  } catch (e) {
    end({ ok: false, error: `Claude Code could not start: ${e?.message ?? e}` });
    return;
  }
  turns.push({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
  // Watchdog: first event, then between events; a running tool keeps its own limit; an ask pauses it.
  entry.timer = setInterval(() => {
    if (entry.ended || entry.asking > 0) return;
    const running = tracker.running();
    const limit = running.length ? BUILD_LIMITS.tool : entry.first ? BUILD_LIMITS.idle : BUILD_LIMITS.first;
    const since = running.length ? Math.max(entry.lastAt, ...running.map((x) => x.startedAt)) : entry.lastAt;
    if (Date.now() - since > limit) {
      const why = running.length ? `a tool ran for over ${limit / 60000} min` : entry.first ? `no activity for ${limit / 1000}s` : `no reply within ${limit / 1000}s`;
      stopBuild(run, "stalled");
      end({ ok: false, stalled: true, error: `Claude stopped responding (${why}).` });
    }
  }, 1000);
  entry.timer.unref?.();
  (async () => {
    let done = null;
    try {
      for await (const m of entry.q) {
        if (entry.ended) break;
        entry.lastAt = Date.now();
        if (m.type === "stream_event" || m.type === "assistant") entry.first = true;
        tracker.on(m);
        if (m.type === "assistant" && !m.parent_tool_use_id) {
          const t = (m.message?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("").trim();
          if (t) send({ type: "build_text", run, text: t });
        }
        if (m.type === "result") {
          tracker.finish(m.is_error);
          done = m.subtype === "success" && !m.is_error ? { ok: true } : { ok: false, error: `Claude Code could not finish (${m.subtype}${m.is_error && m.result ? `: ${m.result}` : ""}).` };
          turns.end();
        }
      }
    } catch (e) {
      if (!done) done = { ok: false, error: e?.message ?? String(e) };
    }
    if (entry.cancelled) done = { ok: false, cancelled: true, error: "Interrupted." };
    end(done ?? { ok: false, error: "Claude Code stopped without a result." });
  })();
}

/** Stops a build session for sure: interrupt, close, kill its Claude Code process tree. */
function stopBuild(run, why) {
  const entry = builds.get(run);
  if (!entry) return;
  if (why === "cancel") entry.cancelled = true;
  entry.q?.interrupt?.().catch(() => {});
  entry.turns.end();
  try {
    entry.q?.close?.();
  } catch {
    /* already gone */
  }
  dlog(`build_stop run=${run} why=${why}`);
  killChild(entry);
}

// ---- Memory passes: one query per chat turn (update) or per new project (seed) ----

const MEMORY_SECTIONS = ["Pitch", "Pillars", "Decisions", "Rejected", "Glossary", "How to work with me"];

const MEMORY_UPDATE_SYSTEM = [
  "You maintain the memory file of a game-design project in Dreamer. You get the current memory.md, the thread, " +
    "the user's latest message, Claude's reply and, for a multiple-choice turn, the question the answer belongs to. " +
    "Call memory_update exactly once. When in doubt, call it with { none: true }: most turns change nothing.",
  "Rules. Save only what the USER stated or explicitly confirmed (an answer they picked counts). Never save Claude's " +
    "suggestions, options, brainstorm lists, or ideas the user did not confirm. Durable facts only: would it still " +
    "matter in a month? No task chatter, no 'user asked about X', no current-step status.",
  "Project-wide facts go to project_ops. Facts about this card's subject go to card_decisions (plain sentences, one " +
    "per item; no heading, no bullet marker), plus a one-line project pointer ONLY if it changes the project's direction. " +
    "In the project chat there is no card: use project_ops only.",
  "Sections: Pitch, Pillars, Decisions, Rejected, Glossary, How to work with me. Ops: add {section,text}; replace " +
    "{section,old,text} (copy old exactly; note '(was: ...)' briefly); remove {section,old}. Lines are short, in the " +
    "user's terms. If a line already says it, do nothing; if it supersedes a line, replace it. An idea the user " +
    "rejected goes to Rejected. Stay under the word cap: consolidate or merge lines instead of appending when near it.",
].join("\n\n");

const MEMORY_SEED_SYSTEM = [
  "You draft the first memory.md of a game-design project in Dreamer from the material given (the Tech & " +
    "constraints card, the Project decisions card, Dream and Lucid cards, and the latest design overview). " +
    "Call memory_seed exactly once.",
  "Terse bullet lines in the user's terms; nothing that the material does not say; no speculation, no ideas that are " +
    "only suggestions. Pitch: 1-2 lines. Pillars: the design pillars. Decisions: settled choices (platform, engine, " +
    "scope, mechanics, tone). Rejected: only what the material says is out. Glossary: project-specific terms. How to " +
    "work with me: working preferences if stated. Leave a section empty rather than guess. At most 450 words in total.",
].join("\n\n");

function memoryTools(job, kind) {
  let sent = false;
  const once = (result) => {
    if (sent) return text("Already recorded; stop now.");
    sent = true;
    send({ type: "memory_result", job, result });
    return text("Recorded. End your turn now.");
  };
  if (kind === "seed") {
    const list = z.array(z.string()).optional();
    return [
      tool("memory_seed", "Record the drafted memory, once.", { pitch: list, pillars: list, decisions: list, rejected: list, glossary: list, how: list }, async (a) => once(a)),
    ];
  }
  return [
    tool(
      "memory_update",
      "Record what to change in the memory, once: { none: true } or project_ops and/or card_decisions.",
      {
        none: z.boolean().optional(),
        project_ops: z
          .array(z.object({ op: z.enum(["add", "replace", "remove"]), section: z.enum(MEMORY_SECTIONS), text: z.string().optional(), old: z.string().optional() }))
          .optional(),
        card_decisions: z.array(z.string()).optional(),
      },
      async (a) => once(a),
    ),
  ];
}

function startMemory(msg) {
  const { job, kind, prompt } = msg;
  const model = typeof msg.model === "string" && msg.model ? msg.model : null;
  const tools = memoryTools(job, kind);
  const turns = makeTurnQueue();
  const entry = { q: null, turns, cancelled: false };
  oneshots.set(job, entry);
  entry.q = query({
    prompt: turns,
    options: {
      systemPrompt: { type: "custom", prompt: kind === "seed" ? MEMORY_SEED_SYSTEM : MEMORY_UPDATE_SYSTEM },
      allowedTools: tools.map((t) => `mcp__memory__${t.name}`),
      tools: [],
      permissionMode: "default",
      settingSources: [],
      maxTurns: 3,
      mcpServers: { memory: createSdkMcpServer({ name: "memory", version: "1.0.0", tools }) },
      includePartialMessages: true,
      ...(model ? { model } : {}),
    },
  });
  turns.push({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null });
  // Only its token count is shown (a muted line under the turn); steps and thinking are not.
  const tracker = makeTracker((o) => o.type === "usage" && send({ ...o, job }));
  (async () => {
    let ok = false;
    try {
      for await (const m of entry.q) {
        tracker.on(m);
        if (m.type === "result") {
          ok = !m.is_error;
          turns.end();
        }
      }
    } catch {
      /* reported as not ok below */
    }
    oneshots.delete(job);
    send({ type: "memory_done", job, ok: ok && !entry.cancelled });
  })();
}

const SUMMARY_SLOT = "{{SUMMARY}}";

const SUMMARY_SYSTEM =
  "You summarize a conversation between a user and Claude about game ideas, for Claude to continue from later. " +
  "Write at most 250 words, plain text, terse, no preamble: what the thread is about, decisions made, open " +
  "questions, current state. Name cards by title. Do not add anything the conversation does not say.";

const RECAP_SLOT = "{{RECAP}}";

const RECAP_SYSTEM =
  "You write a short recap of a conversation between a user and an assistant about game ideas. Another, " +
  "stronger assistant will answer the user's next message from your recap plus the last few messages. " +
  "At most 150 words, plain text, terse, no preamble: the topic, what was decided, which cards were " +
  "discussed (by title), and what the user is trying to do now. Do not add anything the conversation does not say.";

/**
 * One-shot summary of a thread's transcript: its own query, no tools. Null on failure or when it
 * runs past `timeoutMs` (it is then cut: a slow or wedged local model must never hold the turn,
 * least of all a Claude turn waiting for its recap). `local` = {baseUrl} runs it on the local model
 * through Ollama (a local thread's compaction, an escalation's recap). `turn`: stopping that turn
 * stops this too.
 */
async function summarize({ transcript, model, local }, tracker, system = SUMMARY_SYSTEM, { timeoutMs = 120000, turn = null } = {}) {
  const sid = `sum${++sessionSeq}`;
  let q = null;
  let timedOut = false;
  let child = null;
  const stop = () => {
    try {
      q?.close?.();
    } catch {
      /* gone */
    }
    proxyAbort(sid);
    killChild({ sid, child });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    dlog(`summary_timeout turn=${turn?.id ?? "-"} after_ms=${timeoutMs} local=${!!local}`);
    stop();
  }, timeoutMs);
  if (turn) turn.prepQuery = { close: stop };
  try {
    q = query({
      prompt: `Conversation:

${transcript}

${system === RECAP_SYSTEM ? "Recap it." : "Summarize it."}`,
      options: {
        systemPrompt: { type: "custom", prompt: system },
        tools: [],
        allowedTools: [],
        permissionMode: "default",
        settingSources: [],
        maxTurns: 1,
        includePartialMessages: true,
        spawnClaudeCodeProcess: (opts) => (child = spawner({ sid })(opts)),
        ...(model ? { model } : {}),
        ...(local ? { env: localEnv(proxyUrl(sid, FAKE_LOCAL_URL || local.baseUrl), model) } : { env: claudeEnv() }),
      },
    });
    let out = null;
    for await (const m of q) {
      if (turn?.ended) break;
      tracker?.on(m);
      if (m.type === "result" && m.subtype === "success" && !m.is_error) out = String(m.result ?? "").trim();
    }
    return timedOut ? null : out || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (turn?.prepQuery?.close === stop) turn.prepQuery = null;
    proxyAbort(sid);
  }
}

async function handleUserMessage(msg) {
  const local = msg.backend === "local" && msg.local?.baseUrl ? { baseUrl: msg.local.baseUrl, vision: !!msg.local.vision } : null;
  const escalated = !local && msg.escalated === true;
  const key = sessionKey(msg.thread || "default", local ? "local" : "claude", escalated);
  const model = typeof msg.model === "string" && msg.model ? msg.model : null;
  const artifact = !local && msg.artifact?.id ? { id: String(msg.artifact.id), cap: Number(msg.artifact.cap) || DEFAULT_CREDIT_CAP } : null;
  await proxyReady;
  // The UI sends one turn at a time; a new one while another runs means the UI gave up on that one.
  if (current && !current.ended) {
    const old = current;
    dlog(`turn_superseded turn=${old.id} by=${msg.id}`);
    markEnded(old, "superseded");
    sendRaw({ type: "turn_ended", id: old.id, reason: "superseded" });
    if (old.s && !old.s.closed && old.s.busy) closeSession(old.s, "superseded");
  }
  const t = newTurn(msg, { local, artifact, model });
  current = t;
  // A handoff gap interview lasts until another command starts in that thread.
  const thread = msg.thread || "default";
  if (/^\/grill-me handoff/.test(msg.text ?? "")) gapThreads.add(thread);
  else if (/^\//.test(msg.text ?? "")) gapThreads.delete(thread);
  // Likewise a checklist grill.
  if (/^\/grill-me checklist/.test(msg.text ?? "")) checklistThreads.add(thread);
  else if (/^\//.test(msg.text ?? "")) checklistThreads.delete(thread);
  // An escalation always starts fresh (a leftover from an interrupted one is dropped).
  if (escalated && sessions.get(key)) closeSession(sessions.get(key));
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
  let retryText = typeof msg.retryText === "string" ? msg.retryText : null;
  let useFull = !s && !resume;
  if (msg.compact) {
    // Shown as the turn's first step, with its own token count.
    const budget = local ? SUMMARY_MS.local : SUMMARY_MS.claude;
    t.prepUntil = Date.now() + budget + 5000;
    const step = { sid: "compact", kind: "tool", tool: "compact", label: "Summarizing earlier messages…", status: "running", startedAt: Date.now() };
    emit(t, { type: "step", step });
    const tracker = makeTracker((o) => o.type === "usage" && emit(t, { ...o, phase: "compact" }));
    const summary = await summarize({ ...msg.compact, local: msg.compact.local ? local : null }, tracker, SUMMARY_SYSTEM, { timeoutMs: budget, turn: t });
    if (t.ended) return;
    emit(t, { type: "step", step: { ...step, label: summary ? "Summarized earlier messages" : "Could not summarize earlier messages", status: summary ? "done" : "error", endedAt: Date.now() } });
    if (summary) {
      emit(t, { type: "compacted", summary, backend: local ? "local" : "claude" });
      if (s) closeSession(s);
      s = undefined;
      resume = null;
      useFull = true;
      fullText = fullText.replace(SUMMARY_SLOT, summary);
      retryText = retryText?.replace(SUMMARY_SLOT, summary) ?? null;
    } else {
      fullText = fullText.replace(SUMMARY_SLOT, "(summary unavailable)");
      retryText = retryText?.replace(SUMMARY_SLOT, "(summary unavailable)") ?? null;
    }
  }
  if (msg.recap && fullText.includes(RECAP_SLOT)) {
    // The local model recaps the thread for Claude (free); Claude gets the recap, not the transcript.
    // Best effort, on a short budget: a slow local model must never hold up the Claude turn.
    t.prepUntil = Date.now() + RECAP_MS + 5000;
    const step = { sid: "recap", kind: "tool", tool: "recap", label: "Recapping the thread (local model)…", status: "running", startedAt: Date.now() };
    emit(t, { type: "step", step });
    const baseUrl = typeof msg.recap.baseUrl === "string" ? msg.recap.baseUrl : "http://localhost:11434";
    const recap = await summarize({ transcript: msg.recap.transcript, model: msg.recap.model, local: { baseUrl } }, null, RECAP_SYSTEM, { timeoutMs: RECAP_MS, turn: t });
    if (t.ended) return;
    emit(t, { type: "step", step: { ...step, label: recap ? "Recapped the thread (local model)" : "No recap (the local model was too slow); using the last messages", status: recap ? "done" : "error", endedAt: Date.now() } });
    fullText = fullText.replace(RECAP_SLOT, recap ?? "(recap unavailable; see the last messages below)");
    if (!useFull) msg.text = fullText;
  }
  if (t.ended) return;
  const think = msg.think === true && !local;
  // The thread's session was opened for the other mode (chat vs artifact) or is gone: reopen it.
  s = s && !s.closed ? s : sessions.get(key);
  if (s && (s.closed || s.busy)) s = undefined;
  if (s && !!s.artifact !== !!artifact) {
    closeSession(s);
    s = undefined;
  }
  s = s ?? openSession(key, resume, model, think, local, artifact);
  if (artifact) s.artifact = artifact;
  s.escalated = escalated;
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
  t.retryFull = retryText ? turn(retryText) : t.pendingFull;
  s.pending = useFull ? t.pendingFull : turn(msg.text);
  t.diag.sentChars = (useFull ? fullText.length : msg.text.length) + SYSTEM_PROMPT.length + 12000;
  t.phase = "model";
  t.modelStartedAt = Date.now();
  dlog(
    `turn_start turn=${msg.id} thread=${key} session=${sessionWasLive ? "live" : resume ? "resume" : "fresh"} sid=${s.sid} backend=${local ? "local" : "claude"} model=${model ?? "-"} ` +
      `sent=${useFull ? "fullText" : "text"} sentChars=${useFull ? fullText.length : msg.text.length} textChars=${msg.text.length} fullTextChars=${fullText.length} compacted=${!!msg.compact} num_ctx=${t.numCtx ?? "-"}`,
  );
  attach(t, s);
  s.turns.push(s.pending);
}

// ---- One-shot completions (no tools): the Claude side of the organize pipeline ----
// {type:"complete_start", job, system, prompt, model} -> {type:"complete_done", job, ok, text?, error?}
// Claude only (local steps call Ollama from Rust directly). Own watchdog: first event 60 s, then 45 s.
const completions = new Map();
function startCompletion(msg) {
  const { job } = msg;
  const sid = `cmp${++sessionSeq}`;
  const entry = { q: null, child: null, done: false, last: Date.now(), first: 0, started: Date.now() };
  completions.set(job, entry);
  const finish = (r) => {
    if (entry.done) return;
    entry.done = true;
    clearInterval(entry.timer);
    completions.delete(job);
    try {
      entry.q?.close?.();
    } catch {
      /* gone */
    }
    if (!r.ok) killChild({ sid, child: entry.child });
    dlog(`complete_done job=${job} ok=${r.ok} ms=${Date.now() - entry.started}${r.ok ? ` chars=${r.text.length}` : ` error="${r.error}"`}`);
    send({ type: "complete_done", job, ...r });
  };
  entry.timer = setInterval(() => {
    const limit = entry.first ? entry.last + IDLE_MS : entry.started + FIRST_EVENT_MS.claude;
    if (Date.now() > limit) finish({ ok: false, error: entry.first ? `no activity for ${IDLE_MS / 1000}s` : `no reply within ${FIRST_EVENT_MS.claude / 1000}s` });
  }, 1000);
  entry.cancel = () => finish({ ok: false, error: "cancelled", cancelled: true });
  (async () => {
    try {
      entry.q = query({
        prompt: String(msg.prompt ?? ""),
        options: {
          systemPrompt: { type: "custom", prompt: String(msg.system ?? "") },
          tools: [],
          allowedTools: [],
          permissionMode: "default",
          settingSources: [],
          maxTurns: 1,
          includePartialMessages: true,
          spawnClaudeCodeProcess: (opts) => (entry.child = spawner({ sid })(opts)),
          env: { ...claudeEnv(), CLAUDE_CODE_MAX_RETRIES: "2" },
          ...(typeof msg.model === "string" && msg.model ? { model: msg.model } : {}),
        },
      });
      let out = null;
      for await (const m of entry.q) {
        if (entry.done) return;
        entry.last = Date.now();
        if (m.type === "stream_event" && !entry.first) entry.first = Date.now();
        if (m.type === "result") out = m.subtype === "success" && !m.is_error ? { ok: true, text: String(m.result ?? "") } : { ok: false, error: `Claude could not answer (${m.subtype})` };
      }
      finish(out ?? { ok: false, error: "Claude stopped without a result" });
    } catch (e) {
      finish({ ok: false, error: e?.message ?? String(e) });
    }
  })();
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
      if (current?.id === msg.id) failTurn(current, "error", `Claude could not start: ${e?.message ?? e}`, { noRetry: true });
      else send({ type: "error", id: msg.id, message: `Claude could not start: ${e?.message ?? e}` });
    });
  } else if (msg.type === "oneshot_start") {
    startOneshot(msg);
  } else if (msg.type === "memory_start") {
    startMemory(msg);
  } else if (msg.type === "scan_start") {
    startScan(msg);
  } else if (msg.type === "build_start") {
    startBuild(msg);
  } else if (msg.type === "build_cancel") {
    stopBuild(msg.run, "cancel");
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
    sendRaw({ type: "turn_ended", id: t.id, reason: why });
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
    // Every backend's session of that thread.
    for (const s of [...sessions.values()].filter((x) => x.key.startsWith(`${msg.thread}#`))) {
      if (s.turn && !s.turn.ended) {
        const t = s.turn;
        markEnded(t, "reset");
        sendRaw({ type: "turn_ended", id: t.id, reason: "reset" });
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
  for (const run of [...builds.keys()]) stopBuild(run, "cancel");
  setTimeout(() => process.exit(0), 200);
});

console.error(`[sidecar] started: node ${process.version}, cwd ${process.cwd()}, claude ${CLAUDE_EXE || "(SDK default)"}`);
proxyReady.then(() => {
  dlog(`local_proxy port=${proxyPort || "(off)"}`);
  send({ type: "ready" });
});
