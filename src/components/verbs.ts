import type { Card } from "../api";

/** The Claude verbs: one table for the card menu and the chat chips. `cmd` is the message the chat sends. */
export interface Verb {
  label: string;
  cmd: string;
  desc: string;
  /** Only offered when the card(s) carry images. */
  needsImages?: boolean;
  /** Needs web access (the reply says to turn it on when it is off). */
  web?: boolean;
}
export const VERBS: { group: "Deepen" | "Broaden" | "Inspire"; items: Verb[] }[] = [
  { group: "Deepen", items: [
    { label: "Grill me", cmd: "/grill-me", desc: "Question it until it's solid" },
    { label: "Expand", cmd: "/expand", desc: "Develop it further" },
    { label: "Critique", cmd: "/critique", desc: "Find weak spots" },
  ] },
  { group: "Broaden", items: [
    { label: "Give me 3 takes", cmd: "Give me 3 takes", desc: "Three different directions" },
    { label: "What if…", cmd: "/what-if", desc: "Change one core assumption, three times" },
    { label: "Find related", cmd: "/related", desc: "Find and link related cards" },
  ] },
  { group: "Inspire", items: [
    { label: "Find references", cmd: "/references", desc: "Web references to take from", web: true },
    { label: "Describe images", cmd: "/describe", desc: "Describe the images", needsImages: true },
  ] },
];

/** Commands the memory pass skips (an answer to a grill question is not one). */
export const NO_MEMORY = /^(\/expand|\/critique|\/describe|\/merge|\/related|\/grill-me|\/grill-project|\/what-if|\/references|Give me 3 takes|Merge \d+ cards)/;

/** The [Selection] block: all selected cards as one idea, with the links among them. */
export function selectionBlock(cards: Card[]): string {
  const ids = new Set(cards.map((c) => c.id));
  const body = cards.map((c) => {
    const links = (c.links ?? []).filter((l) => ids.has(l.to)).map((l) => `${l.label ? l.label + " " : ""}-> ${l.to}`);
    return [`"${c.title}" (id ${c.id}, stage: ${c.stage}${c.tags.length ? `, tags: ${c.tags.join(", ")}` : ""}${links.length ? `, links: ${links.join("; ")}` : ""})`, c.body || "(no notes yet)"].join("\n");
  });
  return `[Selection] ${cards.length} cards, one idea\n${body.join("\n\n")}`;
}
