// npx tsx scripts/selection-menu.test.ts — selectionMenu: which items show, and that edits are ONE workspace call (= one undo step).
import assert from "node:assert/strict";
import { selectionMenu, type MenuEnv } from "../src/components/canvasMenus";
import type { MenuItem, MenuSection } from "../src/components/ContextMenu";
import type { Card } from "../src/api";

const card = (id: string, o: Partial<Card> = {}): Card => ({ id, title: id, body: "", stage: "mist", tags: [], links: [], attachments: [], kind: "card", ...o }) as Card;
const calls: [string, ...unknown[]][] = [];
const rec = (name: string) => (...a: unknown[]) => void calls.push([name, ...a]);
const ws = new Proxy({ grouped: async (_l: string, fn: () => Promise<unknown>) => void (await fn()) } as Record<string, unknown>, {
  get: (t, k: string) => t[k] ?? rec(k),
});
const mk = (cards: Card[]): MenuEnv =>
  ({
    ws,
    data: { slug: "p", cards, canvas: { cards: Object.fromEntries(cards.map((c) => [c.id, { x: 0, y: 0 }])), frames: {} } },
    rectOf: () => ({ x: 0, y: 0, w: 10, h: 10 }),
    askText: (o: { submit: (v: string) => void }) => o.submit("combat"),
    askClaude: rec("askClaude"),
    merge: rec("merge"),
    duplicate: rec("duplicate"),
    deleteCards: rec("deleteCards"),
  }) as unknown as MenuEnv;

const flat = (ss: MenuSection[]): MenuItem[] => ss.flatMap((s) => s.items);
const all = (ss: MenuSection[]): MenuItem[] => flat(ss).flatMap((i) => [i, ...(i.submenu ? all(i.submenu) : [])]);
const find = (ss: MenuSection[], label: string) => {
  const it = all(ss).find((i) => i.label === label);
  assert.ok(it, `missing "${label}"`);
  return it;
};
const has = (ss: MenuSection[], label: string) => all(ss).some((i) => i.label === label);

// n=1 card
const a = card("a");
let m = selectionMenu([a], mk([a]));
for (const l of ["Open", "Link from here", "Branch", "Deepen", "Broaden", "Inspire", "Visualize", "Copy as prompt", "Hand off…", "Stage", "Add tag…", "Convert to", "Add", "Wrap in frame", "Duplicate", "Bring to front", "Send to back", "Pin position", "Delete"]) assert.ok(has(m, l), l);
for (const l of ["Merge", "Align", "Distribute", "Caption…", "Clear answered", "Open in browser"]) assert.ok(!has(m, l), l);

// n=1 image
const img = card("i", { kind: "image", attachments: [{ id: "x", type: "image", file: "x.png" } as never] });
m = selectionMenu([img], mk([img]));
assert.ok(has(m, "Caption…") && !has(m, "Branch") && !has(m, "Add") && !has(m, "Open in browser"));
assert.equal(find(m, "Describe images").disabled, undefined);
assert.deepEqual(find(m, "Convert to").submenu![0].items.map((i) => i.label), ["Card"]);

// n=3 mixed: card + checklist with an answered item + image
const cl = card("c", { kind: "checklist", items: [{ id: "q", text: "Q (g): why?", done: true, question: true, answer: "because" } as never] });
const trio = [a, cl, img];
const env = mk(trio);
m = selectionMenu(trio, env);
for (const l of ["Merge", "Align", "Distribute", "Clear answered", "Delete 3 cards"]) assert.ok(has(m, l), l);
for (const l of ["Open", "Link from here", "Branch", "Add", "Caption…"]) assert.ok(!has(m, l), l);
assert.deepEqual(find(m, "Convert to").submenu![0].items.map((i) => i.label), ["Card"]); // the only kind all three support

const one = (label: string) => {
  calls.length = 0;
  find(m, label).run!();
  return calls.filter(([n]) => n !== "askClaude");
};
// Edits are one workspace call for all cards.
find(m, "Add tag…").run!();
assert.deepEqual(calls.map(([n]) => n), ["updateMany"]);
assert.equal((calls[0][2] as unknown[]).length, 3);
assert.equal(one("Bring to front").length, 1);
assert.deepEqual(calls[0].slice(0, 2), ["stackCards", ["a", "c", "i"]]);
assert.deepEqual(one("Pin position")[0].slice(0, 3), ["setPinned", ["a", "c", "i"], true]);
assert.equal(one("Duplicate").length, 1);
// Claude: one turn for the whole selection.
calls.length = 0;
find(m, "Grill me").run!();
assert.equal(calls.length, 1);
assert.equal(calls[0][1], null);
assert.match(String(calls[0][2]), /"a".*"c".*"i"/);
// Clear answered goes through grouped (one undo step).
assert.equal(one("Clear answered").length, 1);
console.log("selection menu: ok");
