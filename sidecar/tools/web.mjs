import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { clip } from "../activity.mjs";
import { fail, text } from "../io.mjs";

export function webTools(s, c) {
  const { T, tid, live, hitLimit, requestTool, send } = c;
  const proposeReferenceTool = tool(
    "propose_reference",
    "Propose a reference page as a ghost web-clip card, linked 'inspired by' from the source card(s). Only for a URL you " +
      "opened with WebFetch in this session; never a URL from memory or from search results alone.",
    {
      url: z.string().describe("The exact URL you fetched"),
      take: z.string().max(200).describe("One line: what to take from it"),
      from: z.array(z.string()).min(1).describe("Source card ids (every card of a [Selection])"),
    },
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      if (!s.fetched?.has(args.url)) return text("Refused: that URL was not fetched with WebFetch. Fetch it first, or skip it.");
      try {
        const card = await requestTool("create_reference", { url: args.url, take: args.take }, 30000);
        for (const from of args.from) {
          const ok = await requestTool("propose_link", { from, to: card.id });
          send({ type: "link_proposal", id: tid(), slug: ok.slug, from, to: card.id, label: "inspired by" });
        }
        return text(`Proposed the reference "${card.title}" as a ghost card. It awaits the user's Keep/Dismiss.`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return [proposeReferenceTool];
}
