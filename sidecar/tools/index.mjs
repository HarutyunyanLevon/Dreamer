import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { requestTool as requestToolT, send as sendRaw } from "../io.mjs";
import { touch, turnGate } from "../turn.mjs";
import { artifactChatTools } from "./artifacts.mjs";
import { cardTools } from "./cards.mjs";
import { memoryChatTools } from "./memory.mjs";
import { organizeTools } from "./organize.mjs";
import { questionTools } from "./questions.mjs";
import { webTools } from "./web.mjs";

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
  const c = { T, tid, live, hitLimit, requestTool, send };
  return [webTools, cardTools, questionTools, memoryChatTools, organizeTools, artifactChatTools].flatMap((f) => f(s, c));
}

// A fresh MCP server instance per session: an SDK server object binds to one transport.
export const makeServer = (s) => createSdkMcpServer({ name: "dreamer", version: "1.0.0", tools: chatTools(s) });
