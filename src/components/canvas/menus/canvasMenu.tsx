import { type Card, type CardKind, type ProjectData } from "../../../api";
import { type Workspace } from "../../../state/useWorkspace";
import { type Rect } from "../../cardGeometry";
import { type MenuSection } from "../../ContextMenu";
import { KIND_LABEL, SWATCHES, SWATCH_LABEL, swatchOf } from "../../kinds";
import { pickBundle } from "../../Import";
import { type ArtifactType } from "../../../api";
import { selectionMenu, stageMenu } from "./selectionMenu";

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

export const stageDot = (s: string) => <span className={`dot dot-${s}`} />;
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
