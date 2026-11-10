// Node sidecar: bridges Dreamer's chat panel to the Claude Agent SDK, which in turn drives
// the user's locally installed, already-logged-in Claude Code — no API key.
//
// Protocol: newline-delimited JSON on stdin/stdout.
//   in:  {type:"user_message", id, text}
//        {type:"interrupt"}
//        {type:"tool_response", reqId, result} | {type:"tool_response", reqId, error}
//   out: {type:"ready"}
//        {type:"delta", id, text}                      -- streamed assistant text
//        {type:"question", id, question, choices}       -- ask_question tool fired
//        {type:"message_done", id, text, sessionId, isError}
//        {type:"tool_request", reqId, tool, input}      -- create_card; Rust must reply
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
  "Ask the user exactly one multiple-choice question (used for /grill-me). Present 2-5 short, concrete choices. " +
    "Wait for their answer as the next message before asking another question.",
  {
    question: z.string(),
    choices: z.array(z.string()).min(2).max(5),
  },
  async (args) => {
    send({ type: "question", id: `q${++reqSeq}`, question: args.question, choices: args.choices });
    return { content: [{ type: "text", text: "The question is shown to the user; their answer will arrive as the next message." }] };
  },
);

const dreamerServer = createSdkMcpServer({
  name: "dreamer",
  version: "1.0.0",
  tools: [createCardTool, askQuestionTool],
});

const SYSTEM_PROMPT =
  "You are Claude, embedded as a creative partner inside Dreamer, a desktop app for collecting and deepening game " +
  "ideas. Be a chatty, encouraging collaborator, not a project manager. You can propose new idea cards with " +
  "create_card (always created as a ghost suggestion the user must Keep) and nothing else — you have no file, " +
  "shell or delete access, by design, so the user's plain-file workspace stays theirs. " +
  "When the user asks for /grill-me, use ask_question to ask exactly ONE multiple-choice question at a time about " +
  "the card in context, then stop and wait for their answer before asking the next one; keep questions concrete " +
  "and fun, in the voice of someone who loves the idea and wants it sharper. When given 'Suggest links', look at " +
  "the other cards mentioned in context and suggest 1-3 concrete connections in plain text (you cannot create " +
  "links directly). When given 'Give me 3 takes', propose three distinctly different create_card calls.";

// A queue that the stdin reader pushes into and the query's async-iterable prompt pulls from,
// so one long-lived streaming session can carry many chat turns (and survive interrupts).
function makeTurnQueue() {
  const waiting = [];
  const buffered = [];
  return {
    push(msg) {
      const w = waiting.shift();
      if (w) w(msg);
      else buffered.push(msg);
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffered.length) yield buffered.shift();
        else yield await new Promise((resolve) => waiting.push(resolve));
      }
    },
  };
}

const turns = makeTurnQueue();
let currentId = null;
let currentText = "";

const q = query({
  prompt: turns,
  options: {
    systemPrompt: { type: "custom", prompt: SYSTEM_PROMPT },
    mcpServers: { dreamer: dreamerServer },
    tools: [],
    allowedTools: ["mcp__dreamer__create_card", "mcp__dreamer__ask_question"],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
  },
});

(async () => {
  try {
    for await (const msg of q) {
      if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
        currentText += msg.event.delta.text;
        if (currentId) send({ type: "delta", id: currentId, text: msg.event.delta.text });
      } else if (msg.type === "result") {
        if (currentId) {
          send({ type: "message_done", id: currentId, text: msg.subtype === "success" ? msg.result : currentText, sessionId: msg.session_id, isError: msg.is_error });
        }
        currentId = null;
        currentText = "";
      } else if (msg.type === "assistant" && msg.message?.error) {
        if (currentId) send({ type: "error", id: currentId, message: `Claude could not respond (${msg.message.error}).` });
      }
    }
  } catch (e) {
    send({ type: "error", id: currentId, message: e?.message ?? String(e) });
  }
})();

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
    currentId = msg.id;
    currentText = "";
    turns.push({ type: "user", message: { role: "user", content: [{ type: "text", text: msg.text }] }, parent_tool_use_id: null });
  } else if (msg.type === "interrupt") {
    q.interrupt?.().catch(() => {});
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
