import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { fail, text } from "../io.mjs";

export function organizeTools(s, c) {
  const { T, tid, live, hitLimit, requestTool, send } = c;
  const listTreeTool = tool(
    "list_tree",
    "List the frames and the cards in scope (the project, a frame's cards or the selection, as the request says), " +
      "compactly: ids, titles, tags, stage, position, frame, pinned and links. Call it once before propose_organize.",
    {},
    async (args) => {
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        return text(await requestTool("list_tree", {}), 30000);
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
      "Nothing changes until they apply it. It works on the cards in scope only, with frames, layout and tags. " +
      "Ops: create_frame {tempId, title, rect}, rename {id, title} (frames only), arrange {ids, layout}, place " +
      "{positions: {card id: {x, y}}}, retag {id, add, remove}. Never deletes and never edits card text. Pinned cards " +
      "keep their position: leave them out. If it returns an error, fix every listed op and call it again with the whole plan.",
    {
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
  return [listTreeTool, proposeOrganizeTool];
}
