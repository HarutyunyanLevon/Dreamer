import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fail, text } from "../io.mjs";

export function memoryChatTools(s, c) {
  const { T, tid, live, hitLimit, requestTool, send } = c;
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
  return [rememberTool, forgetTool];
}
