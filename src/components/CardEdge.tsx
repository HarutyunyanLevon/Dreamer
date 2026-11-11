import { memo } from "react";

/**
 * The puffy edge of a Cloud card. A row of overlapping circles runs along the card's rounded
 * outline: zero-length, round-capped dashes on an SVG <rect> whose geometry is set in CSS, so one
 * small SVG fits any card size. Two masks keep only what lies *outside* the card:
 *   - "fill": the union of the circles, minus the card body: soft puffs around the card;
 *   - "ring": the union of slightly larger circles minus the circles minus the card body: a single
 *     scalloped outline in the stage border colour.
 * Nothing is drawn over the card body itself, so text and the frosted background stay untouched.
 *
 * The wobble is a transform animation (compositor only, no repaint), switched on by
 * `.canvas.clouds-move` (see CanvasArea) and off under reduced motion; zoomed far out (`.far`) the
 * SVG is replaced by a cheap dotted border. Sketch, Draft and Pitch borders are plain CSS. Ghost
 * cards keep their own dashed look and get none.
 */
export const CloudEdge = memo(function CloudEdge({ seed }: { seed: string }) {
  // Spread the cards' wobble phases so a canvas of clouds doesn't pulse in unison.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const delay = `-${(Math.abs(h) % 5000) / 1000}s`;
  const id = `cloud-${seed.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg className="edge-cloud" aria-hidden="true" style={{ animationDelay: delay }}>
      <defs>
        <mask id={`${id}-fill`} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect className="puff-path puff-wide" stroke="#fff" />
          <rect className="puff-body" fill="#000" />
        </mask>
        <mask id={`${id}-ring`} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect className="puff-path puff-wide" stroke="#fff" />
          <rect className="puff-path puff-narrow" stroke="#000" />
          <rect className="puff-body" fill="#000" />
        </mask>
      </defs>
      <rect className="puff-full puff-fill" mask={`url(#${id}-fill)`} />
      <rect className="puff-full puff-ring" mask={`url(#${id}-ring)`} />
    </svg>
  );
});
