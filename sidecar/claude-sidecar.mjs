// Node sidecar: bridges Dreamer's chat panel to the Claude Agent SDK, which in turn drives
// the user's locally installed, already-logged-in Claude Code — no API key.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   in:  {type:"user_message", id, text, thread, resume?}   -- thread = "<project>/<card id|project>"
//        {type:"reset_thread", thread}                    -- "Reset chat": drop that thread's session
//        {type:"interrupt"}
//        {type:"tool_response", reqId, result} | {type:"tool_response", reqId, error}
//   out: {type:"ready"}
//        {type:"delta", id, text}                      -- streamed assistant text
//        {type:"question", id, turnId, question, choices}  -- ask_question fired during turn `turnId`
//        {type:"message_done", id, text, sessionId, isError}
//        {type:"tool_request", reqId, tool, input}      -- Rust must reply (create_card, search_cards,
//                                                          read_card, list_related, propose_link)
//        {type:"search", id, query, results}            -- search_cards ran (chat shows result chips)
//        {type:"link_proposal", id, slug, from, to, label, reason}  -- a ghost link to Keep/Dismiss
//        {type:"error", id, message}
import { createInterface } from "node:readline";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const pendingToolReplies = new Map();
let reqSeq = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function requestTool(tool_, input) {
  const reqId = `r${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToolReplies.delete(reqId);
      reject(new Error("timed out waiting for the app"));
    }, 15000);
    pendingToolReplies.set(reqId, { resolve, reject, timer });
    send({ type: "tool_request", reqId, tool: tool_, input });
  });
}

const createCardTool = tool(
  "create_card",
  "Propose a new idea card on the user's canvas. It is always created as a ghost suggestion (dashed outline) " +
    "that the user must explicitly Keep before it counts; never claim it is final. You cannot delete cards.",
  {
    title: z.string().describe("Short card title"),
    body: z.string().optional().describe("Markdown notes for the card body"),
    tags: z.array(z.string()).optional(),
    stage: z.enum(["cloud", "sketch", "draft", "pitch"]).optional(),
    links: z.array(z.object({ to: z.string(), label: z.string().optional() })).optional(),
    branch_group: z.string().optional().describe("When proposing several alternative takes together (e.g. '3 takes'), use the exact same branch_group value on every one of them so Dreamer can group and compare them."),
    variant_of: z.string().optional().describe("The id of the card these takes branch from, if any."),
  },
  async (args) => {
    try {
      const card = await requestTool("create_card", args);
      return { content: [{ type: "text", text: `Created ghost card "${card.title}" (id ${card.id}). It awaits the user's Keep/Dismiss.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Could not create the card: ${e.message}` }], isError: true };
    }
  },
);

const askQuestionTool = tool(
  "ask_question",
  "Ask the user exactly one multiple-choice question (used for /grill-me). Present 2-5 short, neutral, concrete " +
    "choices. The question is shown to the user as a card with buttons, so do not also write it as text. Wait for " +
    "their answer as the next message before asking another question.",
  {
    question: z.string(),
    choices: z.array(z.string()).min(2).max(5),
  },
  async (args) => {
    // turnId ties the question to the reply it belongs to, so the UI shows it once, as the
    // question card, instead of also showing any streamed text for that turn.
    send({ type: "question", id: `q${++reqSeq}`, turnId: currentId, question: args.question, choices: args.choices });
    // Anything the model writes after asking is noise ("the question is above"): drop it, so the
    // turn is the question card and nothing else.
    if (currentSession) currentSession.questionAsked = true;
    // Observed live: without a firm stop here the model sometimes kept going and wrote a guessed
    // "[Answer] ..." itself. The real answer only ever comes as the user's next message.
    return {
      content: [
        {
          type: "text",
          text: "The question is now shown to the user as buttons. END YOUR TURN NOW: write nothing more, do not guess or state an answer. The user's real answer will arrive as their next message.",
        },
      ],
    };
  },
);

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

// ---- Read-only retrieval tools. Rust answers them from its in-memory index; none of them can
// change a card file. ----

const searchCardsTool = tool(
  "search_cards",
  "Keyword search over ALL of the user's idea cards (title, tags, custom fields, body; accent-insensitive, " +
    "light stemming). Returns id, title, stage, tags, project, a snippet and a score, best first. Ghost cards " +
    "(unkept suggestions) are included and marked ghost:true. Use short keyword queries, not sentences; try " +
    "synonyms if nothing comes back.",
  {
    query: z.string().describe("A few keywords"),
    limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8)"),
    scope: z.enum(["all", "project"]).optional().describe("'all' projects (default) or only the open 'project'"),
  },
  async (args) => {
    try {
      const results = await requestTool("search_cards", { query: args.query, limit: args.limit ?? 8, scope: args.scope ?? "all" });
      if (currentId) {
        send({ type: "search", id: currentId, query: args.query, results: results.map((r) => ({ id: r.id, title: r.title, project: r.project, projectName: r.project_name, stage: r.stage, ghost: r.ghost })) });
      }
      return text(results.length ? results : "No cards matched. Try other keywords before concluding the user has no such idea.");
    } catch (e) {
      return fail(e);
    }
  },
);

const readCardTool = tool(
  "read_card",
  "Read one card in full by id: title, stage, tags, fields, body, and its links (with the linked cards' titles).",
  { id: z.string() },
  async (args) => {
    try {
      return text(await requestTool("read_card", { id: args.id }));
    } catch (e) {
      return fail(e);
    }
  },
);

const listRelatedTool = tool(
  "list_related",
  "List cards related to a card: ones it links to, ones linking to it (same project), and cards sharing tags " +
    "(any project), strongest first, with the reason for each.",
  { id: z.string() },
  async (args) => {
    try {
      return text(await requestTool("list_related", { id: args.id }));
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
  },
  async (args) => {
    try {
      const ok = await requestTool("propose_link", { from: args.from, to: args.to });
      send({ type: "link_proposal", id: currentId, slug: ok.slug, from: args.from, to: args.to, label: args.label, reason: args.reason });
      return text(`Proposed a ghost link "${ok.fromTitle}" → "${ok.toTitle}". It awaits the user's Keep/Dismiss.`);
    } catch (e) {
      return fail(e);
    }
  },
);

// A fresh MCP server instance per session: an SDK server object binds to one transport.
const makeServer = () => createSdkMcpServer({
  name: "dreamer",
  version: "1.0.0",
  tools: [createCardTool, askQuestionTool, searchCardsTool, readCardTool, listRelatedTool, proposeLinkTool],
});

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

const SYSTEM_PROMPT = [
  "You are Claude, embedded in Dreamer, a desktop app for collecting and developing game ideas.",
  "Tone: formal, neutral and concise. Answer directly. No exclamation marks, no flattery, no filler, no emoji.",
  "Each user message starts with a [Project context] block listing every card in the project (title, tags, stage), " +
    "then, when a card is selected, that card's details and id. Use read_card for a card's full text and links. " +
    "You can also use search_cards and list_related. Before answering questions about the user's ideas, search the cards. " +
    "Cite cards by title. Never invent cards: if nothing matches, say so.",
  "The only things you can create are suggestions the user must accept: create_card makes a ghost card and " +
    "propose_link makes a ghost link. You have no file, shell, edit or delete access, by design.",
  "/grill-me: interview the user about the selected card, one multiple-choice question per turn, working through " +
    "these items in order and skipping any the card's notes already answer: " +
    GRILL_ITEMS.map((x, i) => `${i + 1}. ${x}`).join("; ") +
    ". On each turn, call ask_question exactly once and write NO other text: no preamble, no restating the question, " +
    "no reaction to the previous answer, no praise or encouragement, no commentary on the option the user chose. " +
    "Questions and options are neutral and specific (2-5 options). The user's answers are recorded in the card's " +
    "notes automatically. When every item has been covered, do not ask another question and do not write a summary " +
    "in chat: call create_card exactly once to propose a spec card with title 'Spec: <card title>', stage 'draft', " +
    "tags including 'spec', a link to the selected card with label 'spec of', and a markdown body with one short " +
    "section per item, built only from the user's answers and the card's notes. Then reply with exactly: " +
    "Proposed a spec card.",
  "/related: use list_related and search_cards (scope 'project') on the selected card, read promising candidates, " +
    "then call propose_link for the 1-5 strongest connections, each with a short label and reason, and list them briefly.",
  "'Give me 3 takes': propose three distinctly different create_card calls.",
].join("\n\n");

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

const MAX_LIVE = 3;
const sessions = new Map();
let currentId = null; // the turn being answered (one at a time; the UI gates on "busy")
let currentSession = null;

const BASE_OPTIONS = {
  systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
  tools: [],
  allowedTools: [
    "mcp__dreamer__create_card",
    "mcp__dreamer__ask_question",
    "mcp__dreamer__search_cards",
    "mcp__dreamer__read_card",
    "mcp__dreamer__list_related",
    "mcp__dreamer__propose_link",
  ],
  permissionMode: "bypassPermissions",
  includePartialMessages: true,
};

function closeSession(s) {
  sessions.delete(s.key);
  s.closed = true;
  s.turns.end();
  try {
    s.q.close?.();
  } catch {
    /* already gone */
  }
}

function evictIfNeeded() {
  while (sessions.size >= MAX_LIVE) {
    const idle = [...sessions.values()].filter((s) => s !== currentSession).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle) break;
    closeSession(idle);
  }
}

function openSession(key, resume) {
  evictIfNeeded();
  const turns = makeTurnQueue();
  const q = query({ prompt: turns, options: { ...BASE_OPTIONS, mcpServers: { dreamer: makeServer() }, ...(resume ? { resume } : {}) } });
  const s = { key, q, turns, resume: resume || null, lastUsed: Date.now(), text: "", answered: false, pending: null, closed: false };
  sessions.set(key, s);
  pump(s);
  return s;
}

function restartFresh(s) {
  sessions.delete(s.key);
  s.closed = true;
  const fresh = openSession(s.key, null);
  if (currentSession === s) currentSession = fresh;
  if (s.pending) {
    fresh.pending = s.pending;
    fresh.turns.push(s.pending);
  }
}

function pump(s) {
  (async () => {
    try {
      for await (const msg of s.q) {
        if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
          s.answered = true;
          s.text += msg.event.delta.text;
          if (currentSession === s && currentId && !s.questionAsked) send({ type: "delta", id: currentId, text: msg.event.delta.text });
        } else if (msg.type === "result") {
          // A resume that can't find its session reports a zero-turn error result (then throws):
          // don't surface it, recover below by starting the thread afresh.
          if (msg.is_error && msg.num_turns === 0 && s.resume && !s.answered) {
            s.resumeFailed = true;
            continue;
          }
          s.answered = true;
          if (currentSession === s && currentId) {
            const text = s.questionAsked && !msg.is_error ? "" : msg.subtype === "success" ? msg.result : s.text;
            send({ type: "message_done", id: currentId, text, sessionId: msg.session_id, isError: msg.is_error });
            currentId = null;
            currentSession = null;
          }
          s.text = "";
          s.pending = null;
        } else if (msg.type === "assistant" && msg.message?.error) {
          if (currentSession === s && currentId) send({ type: "error", id: currentId, message: `Claude could not respond (${msg.message.error}).` });
        }
      }
      if (s.resumeFailed && !s.closed) restartFresh(s);
    } catch (e) {
      if (s.closed) return;
      // A saved session that can't be resumed (deleted, expired): start that thread afresh and
      // replay the turn that was waiting, instead of failing the user's message.
      if (s.resume && !s.answered && s.pending) {
        restartFresh(s);
        return;
      }
      sessions.delete(s.key);
      if (currentSession === s) {
        send({ type: "error", id: currentId, message: e?.message ?? String(e) });
        currentId = null;
        currentSession = null;
      }
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
    const key = msg.thread || "default";
    const s = sessions.get(key) ?? openSession(key, msg.resume);
    s.lastUsed = Date.now();
    s.text = "";
    s.questionAsked = false;
    currentId = msg.id;
    currentSession = s;
    s.pending = { type: "user", message: { role: "user", content: [{ type: "text", text: msg.text }] }, parent_tool_use_id: null };
    s.turns.push(s.pending);
  } else if (msg.type === "interrupt") {
    currentSession?.q.interrupt?.().catch(() => {});
  } else if (msg.type === "reset_thread") {
    const s = sessions.get(msg.thread);
    if (s) closeSession(s);
    if (currentSession === s) {
      currentId = null;
      currentSession = null;
    }
  } else if (msg.type === "tool_response") {
    const pending = pendingToolReplies.get(msg.reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingToolReplies.delete(msg.reqId);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  }
});

send({ type: "ready" });
