import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import type { Card, CardKind, ChecklistItem, ClipAttachment, ImageAttachment } from "../api";
import { useMediaUrl } from "../util/media";
import { IconClip } from "./Icons";

/** Pastel set for frame tints; CSS tints each toward the theme accent (`.tint-<key>`). */
export const SWATCHES = ["butter", "peach", "rose", "lilac", "sky", "mint"] as const;
export type Swatch = (typeof SWATCHES)[number];
export const SWATCH_LABEL: Record<Swatch, string> = { butter: "Butter", peach: "Peach", rose: "Rose", lilac: "Lilac", sky: "Sky", mint: "Mint" };
export const swatchOf = (c: string | undefined, fallback: Swatch | null = "butter"): Swatch | null =>
  (SWATCHES as readonly string[]).includes(c ?? "") ? (c as Swatch) : fallback;

export const KIND_LABEL: Record<CardKind, string> = { card: "Card", checklist: "Checklist", image: "Image", clip: "Clip", artifact: "Artifact" };
/** Kinds "Convert to" moves between (title, body and attachments carry over). */
export const CONVERTIBLE: CardKind[] = ["card", "checklist"];
/** Stage filter, stage visuals and the Mist shader apply only to these. */
export const hasStage = (c: Pick<Card, "kind">) => c.kind === "card";

export const TECH_TITLE = "Tech & constraints";
/** The card that collects the user's project-wide answers (role "decisions"). */
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

/** A Claude Code question's parts: `Q (<card id>): <body> — context: <context>`. Display only; the stored text keeps this shape. */
export function parseItem(text: string): { group?: string; body: string; context?: string } {
  const g = /^Q \(([^)]+)\):\s*/.exec(text);
  const rest = g ? text.slice(g[0].length) : text;
  const c = / — (?=context)(?:context:?\s*)?/.exec(rest);
  return {
    ...(g ? { group: g[1] } : {}),
    body: c ? rest.slice(0, c.index) : rest,
    ...(c ? { context: rest.slice(c.index + c[0].length) } : {}),
  };
}

/** Inverse of parseItem (the context marker is normalized to ` — context: `). */
export const itemText = (group: string | undefined, body: string, context?: string) =>
  `${group ? `Q (${group}): ` : ""}${body}${context !== undefined ? ` — context: ${context}` : ""}`;

/** Ungrouped items first, then one run per group in order of first appearance. */
export function groupItems<T extends { text: string }>(items: T[]): { group?: string; items: T[] }[] {
  const loose: T[] = [];
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const g = parseItem(it.text).group;
    if (g === undefined) loose.push(it);
    else groups.set(g, [...(groups.get(g) ?? []), it]);
  }
  return [...(loose.length ? [{ items: loose }] : []), ...[...groups].map(([group, items]) => ({ group, items }))];
}

export const isAnswered = (i: ChecklistItem) => !!i.question && !!i.answer?.trim();

/** Answered-fold open state per card, for this session (closed by default). */
const foldOpen = new Set<string>();

const grow = (el: HTMLTextAreaElement) => {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
};

/** A textarea as tall as its text (re-measured on input, value change and width change). */
function AutoText(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { "data-item"?: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    grow(el);
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      grow(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.defaultValue]);
  return <textarea ref={ref} rows={1} {...props} onInput={(e) => grow(e.currentTarget)} />;
}

/**
 * A checklist's items, editable on the canvas and in the opened card (`roomy`): checkbox, text,
 * "?" (question) toggle, delete and, for a question, its answer. Enter in an item adds one below;
 * Shift+Enter is a newline; Backspace on an empty item removes it. Text commits on Enter or blur,
 * each change one undo step. Claude Code questions are grouped under their card's title; answered
 * questions sit in a fold at the bottom. `onDelete` removes items (answered ones go to Project decisions).
 */
export function ChecklistBody({ card, onItems, onDelete, titleOf, roomy }: {
  card: Card;
  onItems: (items: ChecklistItem[]) => void;
  onDelete: (ids: string[]) => void;
  titleOf: (id: string) => string | undefined;
  roomy?: boolean;
}) {
  const items = card.items ?? [];
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(() => foldOpen.has(card.id));
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusId = useRef<string | null>(null);

  // Focus an item added with Enter once it comes back from the core.
  useEffect(() => {
    const id = focusId.current;
    if (!id) return;
    const el = listRef.current?.querySelector<HTMLTextAreaElement>(`textarea[data-item="${id}"]`);
    if (el) {
      focusId.current = null;
      el.focus();
    }
  });

  const patch = (id: string, p: Partial<ChecklistItem>) => onItems(items.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const remove = (id: string) => onItems(items.filter((i) => i.id !== id));
  // The canvas edits the body only; the opened card also edits the context.
  const shown = (it: ChecklistItem) => {
    const p = parseItem(it.text);
    return roomy ? itemText(undefined, p.body, p.context) : p.body;
  };
  const textOf = (it: ChecklistItem, v: string) => {
    const p = parseItem(it.text);
    return roomy ? itemText(p.group, v) : itemText(p.group, v, p.context);
  };

  const commitText = (item: ChecklistItem, value: string, addBelow: boolean) => {
    const text = textOf(item, value);
    const next = items.map((i) => (i.id === item.id ? { ...i, text } : i));
    if (addBelow) {
      const n: ChecklistItem = { id: newItemId(), text: "", done: false };
      next.splice(next.findIndex((i) => i.id === item.id) + 1, 0, n);
      focusId.current = n.id;
    } else if (!value.trim()) {
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

  const answered = items.filter(isAnswered);
  const toggleFold = () => {
    if (open) foldOpen.delete(card.id);
    else foldOpen.add(card.id);
    setOpen(!open);
  };

  const row = (it: ChecklistItem) => {
    const { body, context } = parseItem(it.text);
    return (
      <li key={it.id} className={"check-item" + (it.done ? " done" : "") + (it.question ? " question" : "")}>
        <div className="check-row">
          <button
            type="button"
            role="checkbox"
            aria-checked={it.done}
            aria-label={it.done ? `Mark "${body}" not done` : `Mark "${body}" done`}
            className="check-box"
            onClick={() => patch(it.id, { done: !it.done })}
          >
            {it.done ? "✓" : ""}
          </button>
          <AutoText
            key={`${it.id}:${it.text}`}
            data-item={it.id}
            className="check-text"
            defaultValue={shown(it)}
            aria-label="Item"
            placeholder={it.question ? "Question…" : "Item…"}
            onKeyDown={(e) => {
              const v = e.currentTarget.value;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Enter on an empty item just leaves it (blur removes it).
                if (!v.trim()) e.currentTarget.blur();
                else commitText(it, v, true);
              } else if (e.key === "Backspace" && v === "") {
                e.preventDefault();
                remove(it.id);
              } else if (e.key === "Escape") {
                e.currentTarget.value = shown(it);
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
          <button type="button" className="check-del" aria-label="Delete item" title="Delete item" onClick={() => onDelete([it.id])}>
            ×
          </button>
        </div>
        {!roomy && context && <div className="check-context">{context}</div>}
        {it.question && (
          <AutoText
            key={`${it.id}:a:${it.answer ?? ""}`}
            className="check-answer"
            rows={roomy ? 2 : 1}
            defaultValue={it.answer ?? ""}
            aria-label={`Answer to ${body}`}
            placeholder="Answer…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
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
    );
  };
  const list = (subset: ChecklistItem[]) =>
    subset.length > 0 && (
      <ul className="check-items">
        {groupItems(subset).map((g) =>
          g.group === undefined ? (
            g.items.map(row)
          ) : (
            <li key={`g:${g.group}`} className="check-group">
              <div className="check-group-head">{titleOf(g.group) ?? `…${g.group.slice(-5)}`}</div>
              <ul className="check-items">{g.items.map(row)}</ul>
            </li>
          ),
        )}
      </ul>
    );

  return (
    <div className={"checklist" + (roomy ? " roomy" : "")} ref={listRef}>
      {list(items.filter((i) => !isAnswered(i)))}
      {answered.length > 0 && (
        <div className="check-fold">
          <div className="check-fold-head">
            <button type="button" className="check-fold-btn" aria-expanded={open} onClick={toggleFold}>
              {answered.length} answered {open ? "▾" : "▸"}
            </button>
            <button type="button" className="check-fold-clear" onClick={() => onDelete(answered.map((i) => i.id))}>
              Clear answered
            </button>
          </div>
          {open && list(answered)}
        </div>
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
