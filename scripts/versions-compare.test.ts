// npx tsx scripts/versions-compare.test.ts — lineage matching of Compare versions.
import assert from "node:assert/strict";
import type { Card } from "../src/api";
import { compareVersions } from "../src/components/Versions";

const card = (id: string, extra: Partial<Card> = {}): Card =>
  ({ id, title: id, kind: "card", attachments: [], stage: "mist", tags: [], fields: {}, created: "", updated: "", source: "user", ghost: false, links: [], body: "", ...extra }) as Card;

// v1: a, b, gone. v2: a2 (copy of a, edited), b2 (copy of b), fresh. v3: a3 (copy of a2): chains reach v1.
const cards = [
  card("a"), card("b"), card("gone"),
  card("a2", { title: "a", origin: { card: "a", version: "v1" }, body: "edited" }),
  card("b2", { title: "b", origin: { card: "b", version: "v1" } }),
  card("fresh"),
  card("a3", { title: "a", origin: { card: "a2", version: "v2" }, body: "edited" }),
  card("ghost", { ghost: true }),
];
const of = new Map([["a", "v1"], ["b", "v1"], ["gone", "v1"], ["a2", "v2"], ["b2", "v2"], ["fresh", "v2"], ["a3", "v3"], ["ghost", "v2"]]);

const rows = compareVersions(cards, of, "v1", "v2");
const kinds = (k: string) => rows.filter((r) => r.kind === k).map((r) => ("b" in r ? r.b.id : r.a.id)).sort();
assert.deepEqual(kinds("changed"), ["a2"]);
assert.deepEqual(kinds("same"), ["b2"]);
assert.deepEqual(kinds("new"), ["fresh"], "ghosts never count");
assert.deepEqual(kinds("removed"), ["gone"]);

// Chains: v3's a3 descends from v1's a through a2; and the other way round (B older than A).
assert.deepEqual(compareVersions(cards, of, "v1", "v3").filter((r) => r.kind !== "removed").map((r) => r.kind), ["changed"]);
assert.deepEqual(compareVersions(cards, of, "v2", "v1").filter((r) => r.kind === "new").map((r) => ("b" in r ? r.b.id : "")), ["gone"]);
console.log("versions compare: ok");
