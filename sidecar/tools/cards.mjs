import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { clip } from "../activity.mjs";
import { fail, text } from "../io.mjs";

export function cardTools(s, c) {
  const { T, tid, live, hitLimit, requestTool, send } = c;
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
        .union([z.object({ id: z.string(), label: z.string().max(40).optional() }), z.array(z.object({ id: z.string(), label: z.string().max(40).optional() }))])
        .optional()
        .describe("Propose a link from this existing card (or from each card of an array: every card of a [Selection]) to the new one (shown as ghost links the user keeps or dismisses)"),
      kind: z.enum(["card", "checklist"]).optional().describe("Object kind (default 'card'). Use 'checklist' with items for a list of points or questions."),
      items: z
        .array(z.object({ text: z.string(), question: z.boolean().optional().describe("true when the item is an open question") }))
        .optional()
        .describe("Checklist items (kind 'checklist' only)"),
      branch_group: z.string().optional().describe("When proposing several alternative takes together (e.g. '3 takes'), use the exact same branch_group value on every one of them so Dreamer can group and compare them."),
      variant_of: z.string().optional().describe("The id of the card these takes branch from, if any."),
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
        for (const lf of [].concat(linked_from ?? [])) {
          try {
            const ok = await requestTool("propose_link", { from: lf.id, to: card.id });
            send({ type: "link_proposal", id: tid(), slug: ok.slug, from: lf.id, to: card.id, label: lf.label });
            note += ` Proposed a ghost link from "${ok.fromTitle}".`;
          } catch (e) {
            note += ` (Could not propose the link: ${e.message})`;
          }
        }
        return { content: [{ type: "text", text: `Created ghost card "${card.title}" (id ${card.id}). It awaits the user's Keep/Dismiss.${note}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Could not create the card: ${e.message}` }], isError: true };
      }
    },
  );

  /** Shows `qs` as one question form; ask_question and ask_questions both end here. */
  const readCardTool = tool(
    "read_card",
    "Read one card in full by id: title, kind, stage, tags, fields, body, checklist items, role, its links (with the " +
      "linked cards' titles) and its attachments (id, type, caption; for web clips also title, url and has_excerpt). " +
      "Use view_attachment to look at an image or read a clip's saved text.",
    { id: z.string() },
    async (args) => {
      {
        const lim = hitLimit("read");
        if (lim) return lim;
      }
      try {
        return text(await requestTool("read_card", { id: args.id }));
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
      {
        const lim = hitLimit("any");
        if (lim) return lim;
      }
      try {
        const ok = await requestTool("propose_link", { from: args.from, to: args.to });
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
  return [createCardTool, readCardTool, proposeLinkTool, mergeCardsTool, viewAttachmentTool, proposeEditTool];
}
