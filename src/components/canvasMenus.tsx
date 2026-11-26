import { api, type Card, type CardKind, type ProjectData } from "../api";
import type { Workspace } from "../state/useWorkspace";
import { STAGES, STAGE_LABEL } from "../theme/types";
import type { Rect } from "./cardGeometry";
import type { MenuItem, MenuSection } from "./ContextMenu";
import { CONVERTIBLE, KIND_LABEL, isAnswered, SWATCHES, SWATCH_LABEL, hasStage, swatchOf } from "./kinds";
import { isClip, isImage } from "./Attachments";
import { VERBS } from "./verbs";
import { pickBundle } from "./Import";
import type { ArtifactType } from "../api";
import { ARTIFACT_LABEL, ARTIFACT_TYPES, artifactType } from "./artifacts/prompts";

/** What a right-click (or Shift+F10) landed on. */
export type MenuTarget =
  | { kind: "canvas"; point: { x: number; y: number } }
  | { kind: "card"; id: string }
  | { kind: "multi"; ids: string[] }
  | { kind: "link"; from: string; to: string }
  | { kind: "frame"; id: string }
  /** The stage dot on a card face: just the Stage submenu. */
  | { kind: "stage"; id: string };

/** Everything the menus need from the canvas. All card/frame changes go through `ws` (undoable). */
export interface MenuEnv {
  ws: Workspace;
  data: ProjectData;
  rectOf: (id: string) => Rect | undefined;
  /** Open a card: the editor, or the lightbox / clip popover for image and clip objects. */
  open: (c: Card) => void;
  openEditor: (c: Card) => void;
  /** New objects at a world point (the point is the card's centre). */
  addAt: (what: CardKind | "tech" | "questions" | "frame", point: { x: number; y: number }) => void;
  pickImages: (target: { cardId: string } | { point: { x: number; y: number } }) => void;
  promptClip: (target: { cardId: string } | { point: { x: number; y: number } }) => void;
  paste: (point: { x: number; y: number }) => void;
  askText: (o: { title: string; label: string; initial?: string; placeholder?: string; submit: (v: string) => void }) => void;
  selectAll: () => void;
  select: (ids: string[]) => void;
  fit: () => void;
  zoomTo100: () => void;
  /** Send (or, with `prefill`, type into the chat box) an instruction on a card's thread (null = project). */
  askClaude: (thread: string | null, text: string, o?: { display?: string; prefill?: boolean }) => void;
  startLink: (id: string) => void;
  duplicate: (cards: Card[]) => void;
  branch: (c: Card) => void;
  copyPrompt: (cards: Card[]) => void;
  wrap: (ids: string[]) => void;
  merge: (ids: string[]) => void;
  deleteCards: (ids: string[]) => void;
  frameMembers: (id: string) => string[];
  renameFrame: (id: string) => void;
  clearFrameSelection: () => void;
  /** Visualize: one artifact of that type from the cards (brief = their titles, bodies, tags), linked to the first. */
  visualize: (cards: Card[], type: ArtifactType) => void;
  /** Add › Artifact… at a world point. */
  newArtifact: (point: { x: number; y: number }) => void;
  /** Open an artifact's full-size view. */
  openArtifact: (id: string) => void;
}

const stageDot = (s: string) => <span className={`dot dot-${s}`} />;
const swatch = (sw: string | null) => <span className={"cm-swatch" + (sw ? ` tint-${sw}` : " none")} />;

export function menuFor(target: MenuTarget, env: MenuEnv): { label: string; sections: MenuSection[] } | null {
  const { data } = env;
  const find = (id: string) => data.cards.find((c) => c.id === id);
  switch (target.kind) {
    case "canvas":
      return { label: "Canvas menu", sections: canvasMenu(target.point, env) };
    case "card":
    case "multi": {
      const cards = (target.kind === "card" ? [target.id] : target.ids).map(find).filter((c): c is Card => !!c);
      if (!cards.length) return null;
      return { label: cards.length === 1 ? `${KIND_LABEL[cards[0].kind]} menu` : `${cards.length} cards menu`, sections: selectionMenu(cards, env) };
    }
    case "stage": {
      const c = find(target.id);
      return c ? { label: "Stage menu", sections: stageMenu([c], env).submenu! } : null;
    }
    case "link": {
      const from = find(target.from);
      const to = find(target.to);
      const link = from?.links.find((l) => l.to === target.to);
      return from && to && link ? { label: "Link menu", sections: linkMenu(from, to, link.label, env) } : null;
    }
    case "frame":
      return data.canvas.frames?.[target.id] ? { label: "Frame menu", sections: frameMenu(target.id, env) } : null;
  }
}

function canvasMenu(p: { x: number; y: number }, env: MenuEnv): MenuSection[] {
  const tech = env.data.cards.some((c) => c.role === "tech");
  const add = (what: Parameters<MenuEnv["addAt"]>[0]) => () => env.addAt(what, p);
  return [
    {
      title: "Add",
      items: [
        {
          label: "Add",
          submenu: [
            {
              items: [
                { label: "Card", icon: stageDot("mist"), run: add("card") },
                { label: "Checklist", run: add("checklist") },
                { label: "Question list", run: add("questions") },
                { label: "Frame", run: add("frame") },
              ],
            },
            {
              items: [
                { label: "Image…", run: () => env.pickImages({ point: p }) },
                { label: "Web clip…", run: () => env.promptClip({ point: p }) },
                { label: "Artifact…", run: () => env.newArtifact(p) },
              ],
            },
            { items: [{ label: "Tech & constraints card", run: add("tech"), disabled: tech ? "This project already has one" : undefined }] },
          ],
        },
        { label: "Paste", hint: "Ctrl+V", run: () => env.paste(p) },
        { label: "Import bundle…", run: () => pickBundle([p.x - 120, p.y - 80]) },
      ],
    },
    {
      title: "View",
      items: [
        { label: "Select all", hint: "Ctrl+A", run: env.selectAll, disabled: env.data.cards.length ? undefined : "There are no cards yet" },
        { label: "Fit to content", run: env.fit },
        { label: "Zoom to 100%", run: env.zoomTo100 },
      ],
    },
    {
      title: "Claude",
      items: [
        {
          label: "Claude",
          submenu: [
            {
              items: [
                { label: "Grill the project", run: () => env.askClaude(null, "/grill-project") },
                { label: "Organize project", run: () => env.ws.requestChat({ text: "/organize", send: true }) },
                { label: "Hand off project…", run: () => env.ws.openHandoff({ kind: "project" }) },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function stageMenu(cards: Card[], env: MenuEnv): MenuItem {
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

function linkMenu(from: Card, to: Card, label: string | undefined, env: MenuEnv): MenuSection[] {
  const { ws } = env;
  return [
    {
      items: [
        {
          label: "Edit label…",
          run: () => env.askText({ title: "Link label", label: "Label", initial: label ?? "", placeholder: "e.g. inverts", submit: (v) => ws.setLinkLabel(from.id, to.id, v.trim()) }),
        },
        {
          label: "Reverse direction",
          run: () =>
            void ws.updateMany("reverse link", [
              { id: from.id, patch: { links: from.links.filter((l) => l.to !== to.id) } },
              { id: to.id, patch: { links: [...to.links.filter((l) => l.to !== from.id), { to: from.id, label }] } },
            ]),
        },
      ],
    },
    { title: "Danger", items: [{ label: "Delete link", danger: true, run: () => ws.removeLink(from.id, to.id) }] },
  ];
}

function frameMenu(id: string, env: MenuEnv): MenuSection[] {
  const { ws, data } = env;
  const f = data.canvas.frames[id];
  const members = env.frameMembers(id);
  const empty = members.length ? undefined : "The frame has no cards";
  return [
    {
      title: "Frame",
      items: [
        { label: "Rename", run: () => env.renameFrame(id) },
        {
          label: "Color",
          submenu: [
            {
              items: [
                { label: "None", icon: swatch(null), checked: !swatchOf(f.color, null), run: () => ws.updateFrame(id, { color: undefined }, "tint frame") },
                ...SWATCHES.map((sw) => ({ label: SWATCH_LABEL[sw], icon: swatch(sw), checked: swatchOf(f.color, null) === sw, run: () => ws.updateFrame(id, { color: sw }, "tint frame") })),
              ],
            },
          ],
        },
        { label: "Select contents", disabled: empty, run: () => env.select(members) },
        { label: "New card from clipboard", run: () => env.paste({ x: f.x + f.w / 2, y: f.y + f.h / 2 }) },
        {
          label: "Fit to contents",
          disabled: empty,
          run: () => {
            const rs = members.map(env.rectOf).filter((r): r is Rect => !!r);
            if (!rs.length) return;
            const PAD = 40;
            const x = Math.min(...rs.map((r) => r.x)) - PAD;
            const y = Math.min(...rs.map((r) => r.y)) - PAD;
            const w = Math.max(...rs.map((r) => r.x + r.w)) + PAD - x;
            const h = Math.max(...rs.map((r) => r.y + r.h)) + PAD - y;
            ws.updateFrame(id, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, "fit frame");
          },
        },
      ],
    },
    {
      title: "Claude",
      items: [
        { label: "Hand off frame…", disabled: empty, run: () => env.ws.openHandoff({ kind: "frames", ids: [id] }) },
        { label: "Organize this frame", disabled: empty, run: () => env.ws.requestChat({ text: `/organize frame ${id}`, send: true }) },
      ],
    },
    {
      title: "Danger",
      items: [
        {
          label: "Delete frame (keep cards)",
          hint: "Del",
          danger: true,
          run: () => {
            ws.deleteFrame(id);
            env.clearFrameSelection();
          },
        },
        {
          label: members.length ? `Delete frame and ${members.length} card${members.length === 1 ? "" : "s"}` : "Delete frame and cards",
          danger: true,
          run: () => {
            env.clearFrameSelection();
            void ws.deleteFrameAndCards(id, members);
          },
        },
      ],
    },
  ];
}
