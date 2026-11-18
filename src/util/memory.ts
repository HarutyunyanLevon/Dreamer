/** Client-side view of a project's memory.md: six fixed sections of bullet lines (mirrors src-tauri/src/memory.rs). */
export const MEMORY_SECTIONS = ["Pitch", "Pillars", "Decisions", "Rejected", "Glossary", "How to work with me"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];
export type MemoryLines = Record<MemorySection, string[]>;

const PREFIXES = ["pitch", "pillar", "decision", "reject", "gloss", "how"];

export function emptyMemory(): MemoryLines {
  return Object.fromEntries(MEMORY_SECTIONS.map((s) => [s, []])) as unknown as MemoryLines;
}

const clean = (s: string) => s.trim().replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim();

export function parseMemory(text: string): MemoryLines {
  const out = emptyMemory();
  let cur: MemorySection = "Pitch";
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const h = /^(#{2,})\s*(.*)$/.exec(t);
    if (h) {
      const i = PREFIXES.findIndex((p) => h[2].trim().toLowerCase().startsWith(p));
      if (i >= 0) cur = MEMORY_SECTIONS[i];
      continue;
    }
    if (t.startsWith("#")) continue;
    const b = clean(t);
    if (b) out[cur].push(b);
  }
  return out;
}

export function renderMemory(m: MemoryLines): string {
  return MEMORY_SECTIONS.map((s) => `## ${s}\n${m[s].map((l) => `- ${l}\n`).join("")}`).join("\n");
}

export function memoryWords(m: MemoryLines): number {
  return MEMORY_SECTIONS.reduce((n, s) => n + m[s].reduce((k, l) => k + l.split(/\s+/).filter(Boolean).length, 0), 0);
}

/** A section's lines as editor text (one line each, no bullet marker). */
export const toEditor = (lines: string[]) => lines.join("\n");
export const fromEditor = (text: string) => text.split("\n").map(clean).filter(Boolean);
