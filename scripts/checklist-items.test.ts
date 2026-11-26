// npx tsx scripts/checklist-items.test.ts — Claude Code question parsing / grouping on checklists.
import assert from "node:assert/strict";
import { groupItems, itemText, parseItem } from "../src/components/kinds";

const cc = "Q (01ABCDE12345): How fast should the reel spin? — context: combat feel";
assert.deepEqual(parseItem(cc), { group: "01ABCDE12345", body: "How fast should the reel spin?", context: "combat feel" });
assert.equal(itemText("01ABCDE12345", "How fast should the reel spin?", "combat feel"), cc);
// Bare " — context" (no colon) also splits; other dashes stay in the body.
assert.deepEqual(parseItem("Q (T-1): a — b — context of it"), { group: "T-1", body: "a — b", context: "of it" });
assert.deepEqual(parseItem("Q (T-1): how many fish? — combat"), { group: "T-1", body: "how many fish? — combat" });
assert.deepEqual(parseItem("plain to-do"), { body: "plain to-do" });
// Editing the body keeps the stored shape.
const p = parseItem(cc);
assert.equal(itemText(p.group, "Slower?", p.context), "Q (01ABCDE12345): Slower? — context: combat feel");

const items = [{ text: "Q (b): one" }, { text: "loose" }, { text: "Q (a): two" }, { text: "Q (b): three" }];
assert.deepEqual(groupItems(items).map((g) => [g.group, g.items.map((i) => i.text)]), [
  [undefined, ["loose"]],
  ["b", ["Q (b): one", "Q (b): three"]],
  ["a", ["Q (a): two"]],
]);
console.log("checklist items: ok");
