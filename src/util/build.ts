import type { Card } from "../api";

/** A built card whose saved content changed since it was built. */
export const needsRebuild = (c: Card) => c.stage === "built" && !!c.build?.dirty;
/** Built, but Claude Code says only part of it is done. */
export const isPartial = (c: Card) => c.stage === "built" && c.build?.status === "partial";
/** Waiting for, or being worked on by, Claude Code. */
export const buildQueued = (c: Card) => c.build?.status === "queued" || c.build?.status === "in-progress";

export const STATUS_LABEL: Record<string, string> = { queued: "Queued", "in-progress": "In progress", built: "Built", partial: "Partly built", blocked: "Blocked" };

export const evidencePath = (e: string | { path: string }) => (typeof e === "string" ? e : e.path);
