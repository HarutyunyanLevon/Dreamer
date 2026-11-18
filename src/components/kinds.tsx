import { useEffect, useRef, useState } from "react";
import type { Card, CardKind, ChecklistItem, ClipAttachment, ImageAttachment } from "../api";
import { useMediaUrl } from "../util/media";
import { IconClip } from "./Icons";

/** Pastel set shared by stickies and frames; CSS tints each toward the theme accent (`.tint-<key>`). */
export const SWATCHES = ["butter", "peach", "rose", "lilac", "sky", "mint"] as const;
export type Swatch = (typeof SWATCHES)[number];
export const SWATCH_LABEL: Record<Swatch, string> = { butter: "Butter", peach: "Peach", rose: "Rose", lilac: "Lilac", sky: "Sky", mint: "Mint" };
export const swatchOf = (c: string | undefined, fallback: Swatch | null = "butter"): Swatch | null =>
  (SWATCHES as readonly string[]).includes(c ?? "") ? (c as Swatch) : fallback;

export const KIND_LABEL: Record<CardKind, string> = { card: "Card", sticky: "Sticky", label: "Label", checklist: "Checklist", image: "Image", clip: "Clip", artifact: "Artifact" };
/** Kinds "Convert to" moves between (title, body and attachments carry over). */
export const CONVERTIBLE: CardKind[] = ["card", "sticky", "checklist"];
/** Stage filter, stage visuals and the Mist shader apply only to these. */
export const hasStage = (c: Pick<Card, "kind">) => c.kind === "card";

export type LabelSize = "s" | "m" | "l";
export const labelSize = (c: Card): LabelSize => (c.fields.size === "s" || c.fields.size === "l" ? c.fields.size : "m");

export const TECH_TITLE = "Tech & constraints";
/** The card the handoff gap interview writes non-tech answers into (role "decisions"). */
export const DECISIONS_TITLE = "Project decisions";
export const TECH_TEMPLATE = [
  "Engine",
  "Language",
  "Platforms",
  "Input",
  "Target devices",
  "Scope / time budget",
  "Team",
  "Art pipeline",
  "Must avoid",
].map((k) => `- **${k}:** `).join("\n");

export const openQuestions = (items: ChecklistItem[] | undefined) => (items ?? []).filter((i) => i.question && !i.answer?.trim()).length;

const newItemId = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * A checklist's items, editable on the canvas: checkbox, text, "?" (question) toggle and, for a
 * question, its answer. Enter in an item adds one below; Backspace on an empty item removes it.
 * Text commits on Enter or blur, each change one undo step.
 */
export function ChecklistBody({ card, onItems }: { card: Card; onItems: (items: ChecklistItem[]) => void }) {
  const items = card.items ?? [];
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLUListElement | null>(null);
  const focusId = useRef<string | null>(null);

  // Focus an item added with Enter once it comes back from the core.
  useEffect(() => {
    const id = focusId.current;
    if (!id) return;
    const el = listRef.current?.querySelector<HTMLInputElement>(`input[data-item="${id}"]`);
    if (el) {
      focusId.current = null;
      el.focus();
    }
  });

  const patch = (id: string, p: Partial<ChecklistItem>) => onItems(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const remove = (id: string) => onItems(items.filter((i) => i.id !== id));

  const commitText = (item: ChecklistItem, text: string, addBelow: boolean) => {
    const next = items.map((i) => (i.id === item.id ? { ...i, text } : i));
    if (addBelow) {
      const n: ChecklistItem = { id: newItemId(), text: "", done: false };
      next.splice(next.findIndex((i) => i.id === item.id) + 1, 0, n);
      focusId.current = n.id;
    } else if (!text.trim()) {
      onItems(next.filter((i) => i.id !== item.id));
      return;
    }
    if (addBelow || text !== item.text) onItems(next);
  };

  const addDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onItems([...items, { id: newItemId(), text, done: false }]);
  };

  return (
    <div className="checklist">
      {items.length > 0 && (
        <ul className="check-items" ref={listRef}>
          {items.map((it) => (
            <li key={it.id} className={"check-item" + (it.done ? " done" : "") + (it.question ? " question" : "")}>
              <div className="check-row">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={it.done}
                  aria-label={it.done ? `Mark "${it.text}" not done` : `Mark "${it.text}" done`}
                  className="check-box"
                  onClick={() => patch(it.id, { done: !it.done })}
                >
                  {it.done ? "✓" : ""}
                </button>
                <input
                  key={`${it.id}:${it.text}`}
                  data-item={it.id}
                  className="check-text"
                  defaultValue={it.text}
                  aria-label="Item"
                  placeholder={it.question ? "Question…" : "Item…"}
                  onKeyDown={(e) => {
                    const v = e.currentTarget.value;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      // Enter on an empty item just leaves it (blur removes it).
                      if (!v.trim()) e.currentTarget.blur();
                      else commitText(it, v, true);
                    } else if (e.key === "Backspace" && v === "") {
                      e.preventDefault();
                      remove(it.id);
                    } else if (e.key === "Escape") {
                      e.currentTarget.value = it.text;
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => commitText(it, e.currentTarget.value, false)}
                />
                <button
                  type="button"
                  className={"q-toggle" + (it.question ? " on" : "")}
                  aria-pressed={!!it.question}
                  aria-label={it.question ? "Make this a to-do" : "Make this a question"}
                  title={it.question ? "Question (click to make it a to-do)" : "Make this a question"}
                  onClick={() => patch(it.id, { question: !it.question })}
                >
                  ?
                </button>
              </div>
              {it.question && (
                <input
                  key={`${it.id}:a:${it.answer ?? ""}`}
                  className="check-answer"
                  defaultValue={it.answer ?? ""}
                  aria-label={`Answer to ${it.text}`}
                  placeholder="Answer…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") {
                      e.currentTarget.value = it.answer ?? "";
                      e.currentTarget.blur();
                    }
                  }}
                  onBlur={(e) => {
                    const a = e.currentTarget.value.trim();
                    if (a !== (it.answer ?? "")) patch(it.id, { answer: a || undefined });
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <input
        className="check-add"
        value={draft}
        aria-label="Add an item"
        placeholder="+ Add item"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addDraft();
          }
        }}
        onBlur={addDraft}
      />
    </div>
  );
}

/** Image kind: the picture itself, rounded, with an optional caption. */
export function ImageBody({ image, slug, title }: { image: ImageAttachment | undefined; slug: string | null; title: string }) {
  const url = useMediaUrl(slug, image?.path, 480);
  if (!image) return <div className="image-empty">No image yet</div>;
  return (
    <>
      <div className="image-frame">
        {url ? <img src={url} alt={image.caption || title} draggable={false} decoding="async" /> : <div className="image-loading" />}
      </div>
      {image.caption && <div className="image-caption">{image.caption}</div>}
    </>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Clip kind: a link-preview tile (thumbnail, title, site). A click (not a drag) opens the clip popover. */
export function ClipBody({ clip, slug, title }: { clip: ClipAttachment | undefined; slug: string | null; title: string }) {
  const thumb = useMediaUrl(slug, clip?.thumb, 480);
  const icon = useMediaUrl(slug, clip?.favicon, 32);
  if (!clip) return <div className="image-empty">No link yet</div>;
  return (
    <div className="clip-tile">
      {thumb && <img className="clip-thumb" src={thumb} alt="" draggable={false} decoding="async" />}
      <span className="clip-meta">
        <span className="clip-title">{clip.title || title || clip.url}</span>
        <span className="clip-site">
          {icon ? <img src={icon} alt="" width={14} height={14} draggable={false} /> : <IconClip />}
          {clip.site || hostOf(clip.url)}
        </span>
      </span>
    </div>
  );
}
