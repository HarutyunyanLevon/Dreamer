// The chat's last-resort timer (useClaudeChat.lastResortDue): run with `npx tsx scripts/reliability/last-resort.test.ts`.
import assert from "node:assert/strict";
import { LAST_RESORT_MS, lastResortDue } from "../../src/state/useClaudeChat";

const t0 = 1_000_000;
const after = (ms: number) => t0 + ms;

// Not streaming: never.
assert.equal(lastResortDue({ streaming: false, startedAt: t0 }, undefined, after(10 * LAST_RESORT_MS)), false);
// Streaming with nothing since the send: due after the limit, not before.
assert.equal(lastResortDue({ streaming: true, startedAt: t0, lastEventAt: t0 }, undefined, after(LAST_RESORT_MS - 1)), false);
assert.equal(lastResortDue({ streaming: true, startedAt: t0, lastEventAt: t0 }, undefined, after(LAST_RESORT_MS + 1)), true);
// A heartbeat keeps it alive (the sidecar is still on the turn).
assert.equal(lastResortDue({ streaming: true, startedAt: t0, lastEventAt: t0 }, after(60_000), after(60_000 + LAST_RESORT_MS - 1)), false);
// So does any event.
assert.equal(lastResortDue({ streaming: true, startedAt: t0, lastEventAt: after(70_000) }, undefined, after(70_000 + 1000)), false);
// Waiting for the user's credit answer is not a stall; once answered, it is timed again.
assert.equal(lastResortDue({ streaming: true, startedAt: t0, lastEventAt: t0, creditAsk: {} }, undefined, after(10 * LAST_RESORT_MS)), false);
assert.equal(lastResortDue({ streaming: true, startedAt: t0, lastEventAt: t0, creditAsk: { answered: "yes" } }, undefined, after(LAST_RESORT_MS + 1)), true);
console.log("last-resort timer: ok");
