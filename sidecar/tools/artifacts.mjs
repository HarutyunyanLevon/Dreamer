import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fail, text } from "../io.mjs";
import { ARTIFACT_TYPES } from "../prompts/system.mjs";
import { settle } from "../turn.mjs";

export function artifactChatTools(s, c) {
  const { T, tid, live, hitLimit, requestTool, send } = c;
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

  // Find references: a ghost web-clip card for a page that was really fetched this session.
  return [escalateArtifactTool, proposeArtifactTool];
}
