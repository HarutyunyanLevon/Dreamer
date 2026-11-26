import { api, type Card, type CardKind } from "../../../api";
import { STAGES, STAGE_LABEL } from "../../../theme/types";
import { type Rect } from "../../cardGeometry";
import { type MenuItem, type MenuSection } from "../../ContextMenu";
import { CONVERTIBLE, KIND_LABEL, isAnswered, hasStage } from "../../kinds";
import { isClip, isImage } from "../../Attachments";
import { VERBS } from "../../verbs";
import { ARTIFACT_LABEL, ARTIFACT_TYPES, artifactType } from "../../artifacts/prompts";
import { MenuEnv, stageDot } from "./canvasMenu";

export function stageMenu(cards: Card[], env: MenuEnv): MenuItem {
  const staged = cards.filter(hasStage);
  const one = cards.length === 1 ? cards[0] : null;
  return {
    label: "Stage",
    disabled: staged.length ? undefined : one ? `${KIND_LABEL[one.kind]}s have no stage` : "None of these cards has a stage",
    submenu: [
      {
        items: STAGES.map((s) => ({
          label: STAGE_LABEL[s],
          icon: stageDot(s),
          checked: one ? one.stage === s : undefined,
          run: () => {
            const edits = staged.filter((c) => c.stage !== s).map((c) => ({ id: c.id, patch: { stage: s } }));
            if (edits.length === 1) void env.ws.updateCard(edits[0].id, edits[0].patch);
            else void env.ws.updateMany(`set stage to ${STAGE_LABEL[s]}`, edits);
          },
        })),
      },
    ],
  };
}

/** Kinds a card can be turned into (itself included). */
const supports = (c: Card): CardKind[] =>
  c.role || c.ghost || c.kind === "artifact" ? [] : c.kind === "image" || c.kind === "clip" ? [c.kind, "card"] : CONVERTIBLE;

/** The one right-click menu for cards: n >= 1 selected cards, items shown by kind and count. */
export function selectionMenu(cards: Card[], env: MenuEnv): MenuSection[] {
  const { ws } = env;
  const n = cards.length;
  const one = n === 1 ? cards[0] : null;
  const ids = cards.map((c) => c.id);
  const del: MenuSection = { title: "Danger", items: [{ label: one ? "Delete" : `Delete ${n} cards`, hint: "Del", danger: true, run: () => env.deleteCards(ids) }] };
  if (one?.ghost) {
    return [
      {
        items: [
          { label: "Keep", run: () => void ws.keepGhostCard(one.id) },
          { label: "Dismiss", run: () => void ws.deleteCard(one.id) },
          { label: "Open", hint: "Enter", run: () => env.openEditor(one) },
        ],
      },
    ];
  }
  const pinned = cards.every((c) => env.data.canvas.cards[c.id]?.pinned);
  const free = ids.filter((id) => !env.data.canvas.cards[id]?.pinned); // pinned cards stay where they are
  const clip = one?.kind === "clip" ? one.attachments.find(isClip) : undefined;
  const att = one?.kind === "image" ? one.attachments.find(isImage) : clip;
  const checklists = cards.filter((c) => c.kind === "checklist" && (c.items ?? []).some(isAnswered));

  // Always ONE Claude turn; several cards go in together as one [Selection] (the chat reads the canvas selection).
  const ask = (cmd: string) => () => env.askClaude(one ? one.id : null, cmd);
  const hasImages = cards.some((c) => c.attachments.some(isImage));
  const sub = (label: string, items: MenuItem[]): MenuItem => ({ label, submenu: [{ items }] });

  const targets = CONVERTIBLE.filter((k) => cards.every((c) => supports(c).includes(k)) && cards.some((c) => c.kind !== k));
  const convert: MenuItem = {
    label: "Convert to",
    disabled: targets.length ? undefined : one ? (one.role ? `The ${one.role === "tech" ? "Tech & constraints" : "Project decisions"} card stays a card` : `${KIND_LABEL[one.kind]}s can't be converted`) : "These cards can't all become the same kind",
    submenu: [{ items: targets.map((k) => ({ label: KIND_LABEL[k], run: () => void ws.updateMany(`convert to ${KIND_LABEL[k].toLowerCase()}`, cards.filter((c) => c.kind !== k).map((c) => ({ id: c.id, patch: { kind: k } }))) })) }],
  };
  const align = (mode: AlignMode, label: string): MenuItem => ({ label, disabled: free.length > 1 ? undefined : "Pinned cards don't move", run: () => ws.arrangeCards(`align ${mode}`, alignMoves(free, env.rectOf, mode)) });

  const open: MenuItem[] = [];
  if (one) open.push({ label: "Open", hint: "Enter", run: () => (one.kind === "artifact" ? env.openArtifact(one.id) : one.kind === "card" || one.kind === "checklist" ? env.openEditor(one) : env.open(one)) });
  if (one) open.push({ label: "Link from here", hint: "L", run: () => env.startLink(one.id) });
  if (one?.kind === "card") open.push({ label: "Branch", run: () => env.branch(one) });

  const edit: MenuItem[] = [
    stageMenu(cards, env),
    {
      label: "Add tag…",
      run: () =>
        env.askText({
          title: one ? "Add a tag" : `Add a tag to ${n} cards`,
          label: "Tag",
          placeholder: "e.g. combat",
          submit: (v) => {
            const tag = v.trim();
            if (tag) void ws.updateMany(`tag ${n} card${n === 1 ? "" : "s"}`, cards.filter((c) => !c.tags.includes(tag)).map((c) => ({ id: c.id, patch: { tags: [...c.tags, tag] } })));
          },
        }),
    },
    convert,
  ];
  if (one && (one.kind === "card" || one.kind === "checklist")) {
    const add: MenuItem[] = [
      { label: "Image…", run: () => env.pickImages({ cardId: one.id }) },
      { label: "Web clip…", run: () => env.promptClip({ cardId: one.id }) },
    ];
    if (one.kind === "checklist") add.push({ label: "Checklist item", run: () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`.card[data-id="${one.id}"] .check-add`)?.focus()) });
    edit.push(sub("Add", add));
  }
  if (one && att) {
    edit.push({
      label: "Caption…",
      run: () => env.askText({ title: "Caption", label: "Caption", initial: att.caption ?? "", submit: (v) => void ws.setAttachments(one.id, one.attachments.map((a) => (a.id === att.id ? { ...a, caption: v || undefined } : a))) }),
    });
  }
  if (one?.kind === "clip") {
    const none = clip ? undefined : "There's no link yet";
    edit.push(
      { label: "Open in browser", disabled: none, run: () => clip && void api.openUrl(clip.url).catch((e) => ws.setError(String(e))) },
      {
        label: "Refresh preview",
        disabled: none,
        run: () => {
          if (!clip) return;
          ws.toast("Fetching the page…");
          void ws.refreshClip(one.id, clip.id).then(() => ws.toast(null));
        },
      },
    );
  }
  if (one?.kind === "artifact" && artifactType(one) === "theme") {
    edit.push({
      label: "Set as active theme",
      run: () => void api.artifactSetActiveTheme(env.data.slug, one.id).then(() => ws.toast(`"${one.title}" is now the active theme: new artifacts inherit it.`)).catch((e) => ws.setError(String(e))),
    });
  }
  if (checklists.length) {
    edit.push({
      label: "Clear answered",
      run: () => void ws.grouped("clear answered", async () => { for (const c of checklists) await ws.deleteChecklistItems(c.id, (c.items ?? []).filter(isAnswered).map((i) => i.id)); }),
    });
  }

  const claude: MenuItem[] = [
    ...VERBS.map((g) =>
      sub(g.group, g.items.map((v) => ({ label: v.label, disabled: v.needsImages && !hasImages ? "There are no images here" : undefined, run: ask(v.cmd) }))),
    ),
    sub("Visualize", ARTIFACT_TYPES.map((t) => ({ label: ARTIFACT_LABEL[t], run: () => env.visualize(cards, t) }))),
  ];
  if (n > 1) claude.push({ label: "Merge", run: () => env.merge(ids) });
  if (one?.kind === "artifact") {
    claude.push({ label: "Regenerate", run: () => ws.runArtifact(one.id, "Regenerate this artifact from its brief as a new version (start_version mode 'new'). Make the same parts as the current version, a fresh take. Then call suggest_next.", "Regenerate") });
  }
  claude.push({ label: "Copy as prompt", run: () => env.copyPrompt(cards) }, { label: "Hand off…", run: () => ws.openHandoff({ kind: "selection", ids }) });

  const arrange: MenuItem[] = [{ label: "Wrap in frame", hint: "Ctrl+G", run: () => env.wrap(ids) }];
  if (n >= 2) arrange.push(sub("Align", [align("left", "Left"), align("center", "Center"), align("right", "Right"), align("top", "Top"), align("middle", "Middle"), align("bottom", "Bottom")]));
  if (n >= 3) {
    const few = free.length < 3 ? "Needs 3 or more unpinned cards" : undefined;
    arrange.push(sub("Distribute", [
      { label: "Horizontally", disabled: few, run: () => ws.arrangeCards("distribute horizontally", distributeMoves(free, env.rectOf, "x")) },
      { label: "Vertically", disabled: few, run: () => ws.arrangeCards("distribute vertically", distributeMoves(free, env.rectOf, "y")) },
    ]));
  }
  arrange.push(
    { label: "Duplicate", hint: "Ctrl+D", run: () => env.duplicate(cards) },
    { label: "Bring to front", run: () => ws.stackCards(ids, "front") },
    { label: "Send to back", run: () => ws.stackCards(ids, "back") },
    { label: pinned ? "Unpin position" : "Pin position", checked: pinned, run: () => ws.setPinned(ids, !pinned) },
  );
  return [{ title: "Open", items: open }, { title: "Edit", items: edit }, { title: "Claude", items: claude }, { title: "Arrange", items: arrange }, del].filter((s) => s.items.length);
}

type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";

/** New top-left positions for align / distribute (rects from the canvas, auto heights included). */
function alignMoves(ids: string[], rectOf: MenuEnv["rectOf"], mode: AlignMode) {
  const rs = ids.map((id) => [id, rectOf(id)] as const).filter((x): x is readonly [string, Rect] => !!x[1]);
  const minX = Math.min(...rs.map(([, r]) => r.x));
  const maxX = Math.max(...rs.map(([, r]) => r.x + r.w));
  const minY = Math.min(...rs.map(([, r]) => r.y));
  const maxY = Math.max(...rs.map(([, r]) => r.y + r.h));
  const moves: Record<string, { x: number; y: number }> = {};
  for (const [id, r] of rs) {
    const x = mode === "left" ? minX : mode === "right" ? maxX - r.w : mode === "center" ? (minX + maxX) / 2 - r.w / 2 : r.x;
    const y = mode === "top" ? minY : mode === "bottom" ? maxY - r.h : mode === "middle" ? (minY + maxY) / 2 - r.h / 2 : r.y;
    moves[id] = { x, y };
  }
  return moves;
}

/** Equal gaps between neighbours along one axis; the two outermost cards stay put. */
function distributeMoves(ids: string[], rectOf: MenuEnv["rectOf"], axis: "x" | "y") {
  const size = axis === "x" ? "w" : "h";
  const rs = ids
    .map((id) => [id, rectOf(id)] as const)
    .filter((x): x is readonly [string, Rect] => !!x[1])
    .sort((a, b) => a[1][axis] + a[1][size] / 2 - (b[1][axis] + b[1][size] / 2));
  const start = rs[0][1][axis];
  const end = Math.max(...rs.map(([, r]) => r[axis] + r[size]));
  const gap = (end - start - rs.reduce((n, [, r]) => n + r[size], 0)) / (rs.length - 1);
  const moves: Record<string, { x: number; y: number }> = {};
  let at = start;
  for (const [id, r] of rs) {
    moves[id] = axis === "x" ? { x: at, y: r.y } : { x: r.x, y: at };
    at += r[size] + gap;
  }
  return moves;
}
