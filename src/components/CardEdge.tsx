import { memo } from "react";

/**
 * The puffy edge of a Cloud card: a row of overlapping circles along the card's rounded outline,
 * drawn twice (stage-border colour, then a pale fill slightly smaller), which leaves a scalloped
 * "cloud" line. The circles are zero-length round-capped dashes on an SVG <rect> sized in CSS, so
 * one small SVG fits any card size. The subtle wobble is a transform animation (compositor only, no
 * repaint), switched on by `.canvas.clouds-move` (see CanvasArea) and off under reduced motion.
 * Sketch, Draft and Pitch borders are plain CSS. Ghost cards keep their own dashed look and get none.
 */
export const CloudEdge = memo(function CloudEdge({ seed }: { seed: string }) {
  // Spread the cards' wobble phases so a canvas of clouds doesn't pulse in unison.
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const delay = `-${(Math.abs(h) % 5000) / 1000}s`;
  return (
    <svg className="edge-cloud" aria-hidden="true" style={{ animationDelay: delay }}>
      <rect className="puff-o" />
      <rect className="puff-i" />
    </svg>
  );
});
