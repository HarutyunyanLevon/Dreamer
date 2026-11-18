import type { ArtifactType, Card } from "../../api";

export const ARTIFACT_TYPES: ArtifactType[] = ["theme", "character", "concept", "mockup"];
export const ARTIFACT_LABEL: Record<ArtifactType, string> = { theme: "Theme", character: "Character", concept: "Concept art", mockup: "Mockup" };
export const ARTIFACT_HINT: Record<ArtifactType, string> = {
  theme: "A style guide: palette, fonts, mood, art mode and key art. Other artifacts inherit it.",
  character: "A hero image and design notes. Turnaround, expressions and animation on request.",
  concept: "One concept art piece, and the questions it raises.",
  mockup: "An interactive HTML screen, using the theme and the project's sprites.",
};
/** What the first turn makes, per type (the "only what was asked" baseline). */
const PARTS: Record<ArtifactType, string> = {
  theme: "the theme spec, the key art, a private preset from it and the style-guide page",
  character: "the hero image and the design notes (bio, silhouette, palette, personality)",
  concept: "one concept art piece and its notes",
  mockup: "the interactive index.html and its notes",
};

export const artifactType = (c: Pick<Card, "fields">): ArtifactType => {
  const t = c.fields?.artifactType;
  return ARTIFACT_TYPES.includes(t as ArtifactType) ? (t as ArtifactType) : "concept";
};

/** The first artifact turn: make the base parts from the brief, nothing more, then chips. */
export function createPrompt(type: ArtifactType, title: string): string {
  return `Create this ${ARTIFACT_LABEL[type].toLowerCase()}: "${title}". Follow the brief in the artifact block and make only ${PARTS[type]}. Then call suggest_next.`;
}

/** A card's title, body and tags as the brief of an artifact that visualizes it. */
export function briefFromCard(c: Card, type: ArtifactType): string {
  const lines = [`${ARTIFACT_LABEL[type]} for the card "${c.title || "Untitled"}".`];
  if (c.body.trim()) lines.push("", c.body.trim());
  if (c.tags.length) lines.push("", `Tags: ${c.tags.join(", ")}`);
  return lines.join("\n");
}
