import { useState } from "react";
import type { Card } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { STAGE_LABEL, type StageId } from "../theme/types";
import { Modal } from "../ui/Modal";

const INTENTS = ["Develop", "Grill me", "Find twists", "Plan build"] as const;
type Intent = (typeof INTENTS)[number];

/** What to ask for, by intent, tuned to how mature the idea is. Built locally: no Claude call. */
const INSTRUCTION: Record<Intent, Record<StageId, string>> = {
  Develop: {
    mist: "This is a raw spark. Expand it into a clear core concept: what the player does, feels and wants. Offer 3 directions it could go.",
    reverie: "Develop this idea further: sharpen the core loop, fill the obvious gaps and name what is still vague.",
    lucid: "This idea is well formed. Deepen it: concrete mechanics, systems that interact, and content examples.",
    dream: "This idea is mature. Refine it: tighten scope, remove what doesn't serve the core, and polish the pitch.",
  },
  "Grill me": {
    mist: "Ask me hard, open questions, one at a time, to find out what this spark is really about.",
    reverie: "Interview me, one question at a time, to stress-test the core loop, audience and hook.",
    lucid: "Grill me, one question at a time, on the weakest assumptions, risks and contradictions in this design.",
    dream: "Play a skeptical publisher: grill me, one question at a time, on scope, market fit and feasibility.",
  },
  "Find twists": {
    mist: "Suggest 5 surprising twists that would make this spark distinctive. Keep each to one or two sentences.",
    reverie: "Propose 5 twists on the premise, mechanics or setting that would make this stand out from similar games.",
    lucid: "Find 5 twists that subvert player expectations without breaking the core loop, with the trade-off of each.",
    dream: "Suggest a few bold but low-cost twists that would sharpen the hook without growing the scope.",
  },
  "Plan build": {
    mist: "Outline the smallest prototype that would show whether this spark is fun, in a few concrete steps.",
    reverie: "Plan a first playable: the minimum features, a step-by-step build order, and what to test first.",
    lucid: "Write a build plan: milestones from prototype to vertical slice, key technical risks and how to retire them.",
    dream: "Write a production plan: milestones, task breakdown, risks, and a realistic scope for a first release.",
  },
};

const EXCERPT = 200;
const excerpt = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT).trimEnd()}…` : t;
};

export function buildPrompt(card: Card, cards: Card[], intent: Intent): string {
  const linked = card.links
    .map((l) => ({ l, c: cards.find((x) => x.id === l.to) }))
    .filter((x): x is { l: (typeof card.links)[number]; c: Card } => !!x.c);
  const parts = [
    `# ${card.title}`,
    `Stage: ${STAGE_LABEL[card.stage]}${card.tags.length ? `\nTags: ${card.tags.join(", ")}` : ""}`,
    card.body.trim() ? `## Notes\n${card.body.trim()}` : "## Notes\n(none yet)",
  ];
  if (linked.length) {
    parts.push(
      "## Linked cards\n" +
        linked.map(({ l, c }) => `- **${c.title}**${l.label ? ` (${l.label})` : ""}${c.body.trim() ? `: ${excerpt(c.body)}` : ""}`).join("\n"),
    );
  }
  parts.push(`## Task\n${INSTRUCTION[intent][card.stage]}`);
  return parts.join("\n\n");
}

export function PromptModal({ card, cards, ws, onClose }: { card: Card; cards: Card[]; ws: Workspace; onClose: () => void }) {
  const [intent, setIntent] = useState<Intent>("Develop");
  const [text, setText] = useState(() => buildPrompt(card, cards, "Develop"));

  const pick = (i: Intent) => {
    setIntent(i);
    setText(buildPrompt(card, cards, i));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      ws.toast("Prompt copied to the clipboard.");
      onClose();
    } catch (e) {
      ws.setError(`Couldn't copy: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Modal onClose={onClose} label="Prompt" size="md" className="prompt-modal">
      <h3>Prompt from “{card.title}”</h3>
      <div className="prompt-intents" role="radiogroup" aria-label="Intent">
        {INTENTS.map((i) => (
          <button key={i} type="button" role="radio" aria-checked={intent === i} className={"chip" + (intent === i ? " on" : "")} onClick={() => pick(i)}>
            {i}
          </button>
        ))}
      </div>
      <textarea className="prompt-text" aria-label="Prompt text" value={text} onChange={(e) => setText(e.target.value)} rows={14} spellCheck={false} />
      <div className="editor-actions">
        <button type="button" className="btn" onClick={() => void copy()} disabled={!text.trim()}>Copy</button>
        <button
          type="button"
          className="btn primary"
          disabled={!text.trim()}
          onClick={() => {
            ws.requestChat({ text });
            onClose();
          }}
        >
          Send to chat
        </button>
      </div>
    </Modal>
  );
}
