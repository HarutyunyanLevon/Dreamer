import { api, type Card, type CardKind, type ProjectData } from "../api";
import type { Items, Workspace } from "../state/useWorkspace";
import { STAGES, STAGE_LABEL } from "../theme/types";
import type { Rect } from "./cardGeometry";
import type { MenuItem, MenuSection } from "./ContextMenu";
import { CONVERTIBLE, KIND_LABEL, SWATCHES, SWATCH_LABEL, hasStage, labelSize, swatchOf, type LabelSize } from "./kinds";
import { isClip, isImage } from "./Attachments";
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
  | { kind: "folder"; id: string };

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
  duplicate: (c: Card) => void;
  branch: (c: Card) => void;
  copyPrompt: (c: Card) => void;
  wrap: (ids: string[]) => void;
  merge: (ids: string[]) => void;
  deleteCards: (ids: string[]) => void;
  frameMembers: (id: string) => string[];
  renameFrame: (id: string) => void;
  clearFrameSelection: () => void;
  /** New folder at a world point (its centre), name field focused. */
  newFolder: (point: { x: number; y: number }) => void;
  /** These items move into a new folder. */
  groupIntoFolder: (items: Items) => void;
  /** Everything inside a frame: cards, folder nodes, smaller frames. */
  frameContents: (id: string) => Items;
  renameFolder: (id: string) => void;
  /** Folder nodes selected on the canvas. */
  folderSelection: string[];
  /** Card › Visualize… : an artifact of that type from the card (brief = title, body, tags), linked to it. */
  visualize: (c: Card, type: ArtifactType) => void;
  /** Add › New artifact… at a world point. */
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
    case "card": {
      const c = find(target.id);
      if (!c) return null;
      if (c.ghost) return { label: "Suggestion menu", sections: ghostMenu(c, env) };
      if (c.kind === "artifact") return { label: `${ARTIFACT_LABEL[artifactType(c)]} menu`, sections: artifactMenu(c, env) };
      if (c.kind === "image" || c.kind === "clip") return { label: `${KIND_LABEL[c.kind]} menu`, sections: objectMenu(c, env) };
      return { label: `${KIND_LABEL[c.kind]} menu`, sections: cardMenu(c, env) };
    }
    case "multi": {
      const cards = target.ids.map(find).filter((c): c is Card => !!c);
      return cards.length > 1 ? { label: `${cards.length} cards menu`, sections: multiMenu(cards, env) } : null;
    }
    case "link": {
      const from = find(target.from);
      const to = find(target.to);
      const link = from?.links.find((l) => l.to === target.to);
      return from && to && link ? { label: "Link menu", sections: linkMenu(from, to, link.label, env) } : null;
    }
    case "frame":
      return data.canvas.frames?.[target.id] ? { label: "Frame menu", sections: frameMenu(target.id, env) } : null;
    case "folder":
      return data.canvas.folders?.[target.id] ? { label: "Folder menu", sections: folderMenu(target.id, env) } : null;
  }
}

function pinItem(kind: "cards" | "folders", id: string, env: MenuEnv): MenuItem {
  const pinned = !!env.data.canvas[kind]?.[id]?.pinned;
  return { label: pinned ? "Unpin position" : "Pin position", checked: pinned, run: () => env.ws.setPinned(kind, id, !pinned) };
}

function folderMenu(id: string, env: MenuEnv): MenuSection[] {
  const { ws, data } = env;
  const f = data.folders.find((x) => x.id === id);
  if (!f) return [];
  const sel = env.folderSelection.includes(id) ? env.folderSelection : [id];
  if (f.kind === "version" && !f.parent) {
    const name = f.title.trim() || "Untitled folder";
    return [
      {
        title: "Version",
        items: [
          { label: "Open", hint: "Enter", run: () => ws.openFolder(id) },
          { label: "Rename version", run: () => ws.setVersionDialog({ kind: "rename", id }) },
          { label: `New version from ${name}…`, run: () => ws.setVersionDialog({ kind: "new", from: id }) },
          { label: "Compare versions…", run: () => ws.setVersionDialog({ kind: "compare", b: id }) },
        ],
      },
      { title: "Claude", items: [{ label: "Summarize this version…", run: () => ws.openHandoff({ kind: "folder", id }) }] },
      { title: "Arrange", items: [pinItem("folders", id, env), { label: "Bring to front", run: () => ws.setFolderStacking(id, "front") }, { label: "Send to back", run: () => ws.setFolderStacking(id, "back") }] },
      { title: "Danger", items: [{ label: "Delete version", danger: true, run: () => void ws.deleteFolder(id) }] },
    ];
  }
  return [
    {
      title: "Folder",
      items: [
        { label: "Open", hint: "Enter", run: () => ws.openFolder(id) },
        { label: "Rename", run: () => env.renameFolder(id) },
        {
          label: "Color",
          submenu: [
            {
              items: [
                { label: "None", icon: swatch(null), checked: !swatchOf(f.color, null), run: () => ws.updateFolder(id, { color: undefined }, "tint folder") },
                ...SWATCHES.map((sw) => ({ label: SWATCH_LABEL[sw], icon: swatch(sw), checked: swatchOf(f.color, null) === sw, run: () => ws.updateFolder(id, { color: sw }, "tint folder") })),
              ],
            },
          ],
        },
        { label: "New folder", run: () => env.newFolder({ x: (data.canvas.folders[id]?.x ?? 0) + 340, y: (data.canvas.folders[id]?.y ?? 0) + 80 }) },
        { label: sel.length > 1 ? `Group ${sel.length} folders into a folder` : "Group into folder", run: () => env.groupIntoFolder({ folders: sel }) },
      ],
    },
    { title: "Claude", items: [{ label: "Summarize this folder…", run: () => ws.openHandoff({ kind: "folder", id }) }] },
    {
      title: "Arrange",
      items: [
        { label: "Lay out as frame", run: () => void ws.folderToFrame(id) },
        { label: "Ungroup folder", run: () => void ws.ungroupFolder(id) },
        pinItem("folders", id, env),
        { label: "Bring to front", run: () => ws.setFolderStacking(id, "front") },
        { label: "Send to back", run: () => ws.setFolderStacking(id, "back") },
      ],
    },
    { title: "Danger", items: [{ label: "Delete folder", hint: "Del", danger: true, run: () => void ws.deleteFolder(id) }] },
  ];
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
                { label: "Card (Mist)", icon: stageDot("mist"), run: add("card") },
                { label: "Sticky", run: add("sticky") },
                { label: "Text label", run: add("label") },
                { label: "Checklist", run: add("checklist") },
                { label: "Question list", run: add("questions") },
                { label: "Frame", run: add("frame") },
                { label: "Folder", run: () => env.newFolder(p) },
              ],
            },
            { items: [{ label: "New artifact…", run: () => env.newArtifact(p) }] },
            {
              items: [
                { label: "Image…", run: () => env.pickImages({ point: p }) },
                { label: "Web clip…", run: () => env.promptClip({ point: p }) },
              ],
            },
            { items: [{ label: "Tech & constraints card", run: add("tech"), disabled: tech ? "This project already has one" : undefined }] },
          ],
        },
        { label: "New folder", run: () => env.newFolder(p) },
        { label: "Paste", hint: "Ctrl+V", run: () => env.paste(p) },
        { label: "New card from clipboard", run: () => env.paste(p) },
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
                {
                  label: "Gap check…",
                  run: () =>
                    env.askClaude(
                      null,
                      "Gap check: go through this project's cards and list the most important gaps: core decisions not made yet, questions nobody has answered, contradictions between cards, and parts of the game no card covers. Then propose up to 3 ghost cards for the biggest gaps.",
                      { prefill: true },
                    ),
                },
                { label: "Summarize project…", run: () => env.ws.openHandoff({ kind: "project" }) },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function ghostMenu(c: Card, env: MenuEnv): MenuSection[] {
  return [
    {
      items: [
        { label: "Keep", run: () => void env.ws.keepGhostCard(c.id) },
        { label: "Dismiss", run: () => void env.ws.deleteCard(c.id) },
        { label: "Open", hint: "Enter", run: () => env.openEditor(c) },
      ],
    },
  ];
}

function stageMenu(cards: Card[], env: MenuEnv): MenuItem {
  const staged = cards.filter(hasStage);
  const one = cards.length === 1 ? cards[0] : null;
  return {
    label: "Set stage",
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

function claudeCardMenu(c: Card, env: MenuEnv): MenuItem {
  const ask = (display: string) => () => env.askClaude(c.id, display);
  const hasImages = c.attachments.some(isImage);
  const items: MenuItem[] = [
    { label: "Grill me", run: ask("/grill-me") },
    { label: "Give me 3 takes", run: ask("Give me 3 takes") },
    { label: "Find related", run: ask("/related") },
    { label: "Expand", run: ask("/expand") },
    { label: "Critique", run: ask("/critique") },
  ];
  if (hasImages) items.push({ label: "Describe images", run: ask("/describe") });
  items.push({ label: "Summarize from here…", run: () => env.ws.openHandoff({ kind: "card", id: c.id }) });
  return { label: "Claude", submenu: [{ items }] };
}

/** Card › Visualize… › Theme / Character / Concept / Mockup. */
function visualizeMenu(c: Card, env: MenuEnv): MenuItem {
  return { label: "Visualize…", submenu: [{ items: ARTIFACT_TYPES.map((t) => ({ label: ARTIFACT_LABEL[t], run: () => env.visualize(c, t) })) }] };
}

function artifactMenu(c: Card, env: MenuEnv): MenuSection[] {
  const { ws } = env;
  const type = artifactType(c);
  const items: MenuItem[] = [{ label: "Open full size", hint: "Enter", run: () => env.openArtifact(c.id) }];
  if (type === "theme") {
    items.push({
      label: "Set as active theme",
      run: () =>
        void api
          .artifactSetActiveTheme(env.data.slug, c.id)
          .then(() => ws.toast(`"${c.title}" is now the active theme: new artifacts inherit it.`))
          .catch((e) => ws.setError(String(e))),
    });
  }
  return [
    { title: "Artifact", items },
    {
      title: "Claude",
      items: [
        { label: "Regenerate", run: () => ws.runArtifact(c.id, "Regenerate this artifact from its brief as a new version (start_version mode 'new'). Make the same parts as the current version, a fresh take. Then call suggest_next.", "Regenerate") },
        { label: "Feedback…", run: () => env.askClaude(c.id, "", { prefill: true }) },
      ],
    },
    {
      title: "Arrange",
      items: [
        { label: "Link from here", hint: "L", run: () => env.startLink(c.id) },
        { label: "Wrap in frame", hint: "Ctrl+G", run: () => env.wrap([c.id]) },
        { label: "Group into folder", run: () => env.groupIntoFolder({ cards: [c.id] }) },
        pinItem("cards", c.id, env),
        { label: "Bring to front", run: () => ws.bringToFront(c.id) },
        { label: "Send to back", run: () => ws.sendToBack(c.id) },
      ],
    },
    { title: "Danger", items: [{ label: "Delete", hint: "Del", danger: true, run: () => env.deleteCards([c.id]) }] },
  ];
}

function cardMenu(c: Card, env: MenuEnv): MenuSection[] {
  const { ws } = env;
  const isLabel = c.kind === "label";
  const addItems: MenuItem[] = [
    { label: "Image…", run: () => env.pickImages({ cardId: c.id }) },
    { label: "Web clip…", run: () => env.promptClip({ cardId: c.id }) },
  ];
  if (c.kind === "checklist") {
    addItems.push({
      label: "Checklist item",
      run: () => requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`.card[data-id="${c.id}"] .check-add`)?.focus()),
    });
  }
  const convertible = CONVERTIBLE.includes(c.kind) && !c.role;
  const arrange: MenuItem[] = [
    { label: "Link from here", hint: "L", run: () => env.startLink(c.id) },
    { label: "Duplicate", hint: "Ctrl+D", run: () => env.duplicate(c) },
    { label: "Branch", run: () => env.branch(c) },
    { label: "Copy as prompt", run: () => env.copyPrompt(c) },
    {
      label: "Convert to",
      disabled: convertible ? undefined : c.role ? `The ${c.role === "tech" ? "Tech & constraints" : "Project decisions"} card stays a card` : `${KIND_LABEL[c.kind]}s can't be converted`,
      submenu: [{ items: CONVERTIBLE.filter((k) => k !== c.kind).map((k) => ({ label: KIND_LABEL[k], run: () => void ws.convertKind(c.id, k) })) }],
    },
  ];
  if (c.kind === "sticky") {
    arrange.push({
      label: "Color",
      submenu: [{ items: SWATCHES.map((sw) => ({ label: SWATCH_LABEL[sw], icon: swatch(sw), checked: swatchOf(c.color) === sw, run: () => void ws.updateCard(c.id, { color: sw }) })) }],
    });
  }
  if (isLabel) {
    const sizes: [LabelSize, string][] = [["s", "Small"], ["m", "Medium"], ["l", "Large"]];
    arrange.push({
      label: "Size",
      submenu: [{ items: sizes.map(([sz, name]) => ({ label: name, checked: labelSize(c) === sz, run: () => void ws.updateCard(c.id, { fields: { ...c.fields, size: sz } }) })) }],
    });
  }
  arrange.push(
    { label: "Wrap in frame", hint: "Ctrl+G", run: () => env.wrap([c.id]) },
    { label: "Group into folder", run: () => env.groupIntoFolder({ cards: [c.id] }) },
    pinItem("cards", c.id, env),
    { label: "Bring to front", run: () => ws.bringToFront(c.id) },
    { label: "Send to back", run: () => ws.sendToBack(c.id) },
  );
  return [
    {
      title: "Add",
      items: [
        { label: "Open", hint: "Enter", run: () => env.openEditor(c) },
        { label: "Add", disabled: isLabel ? "Labels don't show images or clips" : undefined, submenu: [{ items: addItems }] },
        stageMenu([c], env),
      ],
    },
    { title: "Claude", items: [claudeCardMenu(c, env), visualizeMenu(c, env)] },
    { title: "Arrange", items: arrange },
    { title: "Danger", items: [{ label: "Delete", hint: "Del", danger: true, run: () => env.deleteCards([c.id]) }] },
  ];
}

function objectMenu(c: Card, env: MenuEnv): MenuSection[] {
  const { ws } = env;
  const att = c.kind === "image" ? c.attachments.find(isImage) : c.attachments.find(isClip);
  const items: MenuItem[] = [
    { label: "Open", hint: "Enter", run: () => env.open(c) },
    {
      label: "Edit caption…",
      disabled: att ? undefined : "There's nothing to caption yet",
      run: () =>
        att &&
        env.askText({
          title: "Caption",
          label: "Caption",
          initial: att.caption ?? "",
          submit: (v) => void ws.setAttachments(c.id, c.attachments.map((a) => (a.id === att.id ? { ...a, caption: v || undefined } : a))),
        }),
    },
  ];
  const claude: MenuItem[] = [visualizeMenu(c, env)];
  if (c.kind === "image") claude.push({ label: "Describe image", disabled: att ? undefined : "There's no image yet", run: () => env.askClaude(c.id, "/describe") });
  if (c.kind === "clip") {
    const clip = att && isClip(att) ? att : undefined;
    items.push(
      { label: "Open in browser", disabled: clip ? undefined : "There's no link yet", run: () => clip && void api.openUrl(clip.url).catch((e) => ws.setError(String(e))) },
      {
        label: "Refresh preview",
        disabled: clip ? undefined : "There's no link yet",
        run: () => {
          if (!clip) return;
          ws.toast("Fetching the page…");
          void ws.refreshClip(c.id, clip.id).then(() => ws.toast(null));
        },
      },
    );
  }
  return [
    { title: "Object", items },
    ...(claude.length ? [{ title: "Claude", items: claude }] : []),
    {
      title: "Arrange",
      items: [
        { label: "Convert to card", run: () => void ws.convertKind(c.id, "card") },
        { label: "Group into folder", run: () => env.groupIntoFolder({ cards: [c.id] }) },
        pinItem("cards", c.id, env),
        { label: "Bring to front", run: () => ws.bringToFront(c.id) },
        { label: "Send to back", run: () => ws.sendToBack(c.id) },
      ],
    },
    { title: "Danger", items: [{ label: "Delete", hint: "Del", danger: true, run: () => env.deleteCards([c.id]) }] },
  ];
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

function multiMenu(cards: Card[], env: MenuEnv): MenuSection[] {
  const { ws } = env;
  const ids = cards.map((c) => c.id);
  const n = cards.length;
  // Pinned cards stay where they are.
  const free = ids.filter((id) => !env.data.canvas.cards[id]?.pinned);
  const align = (mode: AlignMode, label: string): MenuItem => ({ label, disabled: free.length > 1 ? undefined : "Pinned cards don't move", run: () => ws.arrangeCards(`align ${mode}`, alignMoves(free, env.rectOf, mode)) });
  return [
    {
      title: "Edit",
      items: [
        stageMenu(cards, env),
        {
          label: "Add tag…",
          run: () =>
            env.askText({
              title: `Add a tag to ${n} cards`,
              label: "Tag",
              placeholder: "e.g. combat",
              submit: (v) => {
                const tag = v.trim();
                if (!tag) return;
                void ws.updateMany(`tag ${n} cards`, cards.filter((c) => !c.tags.includes(tag)).map((c) => ({ id: c.id, patch: { tags: [...c.tags, tag] } })));
              },
            }),
        },
      ],
    },
    {
      title: "Claude",
      items: [
        { label: "Merge with Claude", run: () => env.merge(ids) },
        { label: "Summarize selection…", run: () => env.ws.openHandoff({ kind: "selection", ids: cards.map((c) => c.id) }) },
      ],
    },
    {
      title: "Arrange",
      items: [
        { label: "Wrap in frame", hint: "Ctrl+G", run: () => env.wrap(ids) },
        { label: env.folderSelection.length ? `Group ${n} cards and ${env.folderSelection.length} folder${env.folderSelection.length === 1 ? "" : "s"} into a folder` : "Group into folder", run: () => env.groupIntoFolder({ cards: ids, folders: env.folderSelection }) },
        {
          label: "Align",
          submenu: [
            { items: [align("left", "Left"), align("center", "Center"), align("right", "Right")] },
            { items: [align("top", "Top"), align("middle", "Middle"), align("bottom", "Bottom")] },
          ],
        },
        {
          label: "Distribute",
          disabled: n < 3 ? "Needs 3 or more cards" : undefined,
          submenu: [
            {
              items: [
                { label: "Horizontally", disabled: free.length < 3 ? "Needs 3 or more unpinned cards" : undefined, run: () => ws.arrangeCards("distribute horizontally", distributeMoves(free, env.rectOf, "x")) },
                { label: "Vertically", disabled: free.length < 3 ? "Needs 3 or more unpinned cards" : undefined, run: () => ws.arrangeCards("distribute vertically", distributeMoves(free, env.rectOf, "y")) },
              ],
            },
          ],
        },
      ],
    },
    { title: "Danger", items: [{ label: `Delete ${n} cards`, hint: "Del", danger: true, run: () => env.deleteCards(ids) }] },
  ];
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
          label: "Turn into folder",
          run: () => {
            env.clearFrameSelection();
            ws.frameToFolder(id, env.frameContents(id));
          },
        },
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
        { label: "Summarize this frame…", disabled: empty, run: () => env.ws.openHandoff({ kind: "frames", ids: [id] }) },
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
