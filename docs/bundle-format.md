# `.dreamer.md` bundle format (v1)

A bundle is one UTF-8 text file (LF or CRLF, optional BOM) that carries cards into Dreamer.
Claude (claude.ai, Claude Code) writes them; Dreamer imports them as suggestions (ghost cards).
Parser: `src-tauri/src/bundle.rs`. Import: `src-tauri/src/storage/import.rs`.

## Layout

```
---
dreamer_bundle: 1
bundle_id: fish-ideas-1        # stable; the same id when a bundle is re-sent
title: Fishing ideas           # short label
project: Fish Game             # optional: slug or name; default = open project
version: v2                    # optional: version title; default = open version
frame: Harbour                 # optional default frame for all cards
source: claude.ai              # claude.ai | claude-code | dreamer-scan | other
created: 2026-11-25T10:00:00Z
---
<!-- card -->
---
ref: timing-bar                # unique within the bundle
id: 01J...                     # optional: an existing Dreamer card -> update proposal
title: Timing bar
stage: lucid                   # mist|reverie|lucid|dream|built (default mist)
tags: [fishing, input]
frame: Harbour                 # optional, overrides the header
links: [{to: net, label: needs}]   # to = a ref of this bundle or a card id
fields: {difficulty: 2}        # optional
---
Markdown body until the next `<!-- card -->` line or the end of the file.
A `---` line inside the body is fine.
```

## Lenient parsing

| Input | Result |
|---|---|
| Surrounding ```` ```dreamer ````, ```` ```markdown ```` or ```` ``` ```` fence | stripped |
| Unknown header or card key | ignored, warning |
| Unknown `source` | `other`, warning |
| Unknown `stage` | `mist`, warning |
| `build:` key | ignored (build status is not tracked in Dreamer); `stage: built` is just the Built stage |
| Duplicate `ref` | renamed `ref-2`, warning |
| Missing `ref` | made up, warning |
| Link to an unknown ref | dropped, warning |
| Bad YAML in one card | that card skipped, warning; the rest import |
| No `bundle_id` | made from the title and refs (stable for the same content), warning |

**Detection** (`looksLikeBundle`): after an optional fence, the first non-blank line is `---` and the header contains `dreamer_bundle`. Plain cards with front matter are not bundles.

## Import

1. **Target.** Project by slug/name (case-insensitive), else the open project. Version by title, else the open one. Frames by title on that version's root canvas; missing frames are created to the right of existing content. An unresolved project or version makes the preview ask.
2. **Per card.**
   - `id` given and the card exists: update proposal (the normal proposal flow).
   - else `bundle_id` + `ref` equals a card's stored `import`: update proposal, or replace the ghost if it is still a ghost.
   - else a new ghost card with `import: {bundle_id, ref, source}`.
3. **Placement.** Deterministic grid (the organize layout helper) at the paste/drop point or inside the target frame; never overlapping.
4. **After import.** A pill shows "N cards imported as suggestions" with Keep all / Dismiss all / Undo while ghosts from the import remain.

## Ways in

- Ctrl+V on the canvas (not while typing in a field), or "New card from clipboard".
- Dropping a `.dreamer.md` (or any `.md` that detects as a bundle) on the canvas.
- "Import bundle…" in the sidebar and the canvas context menu.
- Drop folders: `<workspace>/import/` and `<repo>/.dreamer/outbox/` for each project with a repo. A new `*.dreamer.md` offers "Import N cards from <source>?"; afterwards it is moved to `imported/` next to it (never deleted). Files that arrived while the app was closed are offered at the next start.

## Clipboard cards (non-bundle)

Order: bundle, image data (saved to `media/`), files (images become image cards, `.dreamer.md` imports, others ignored with a toast), a single URL line (web clip), text (first line, max 80 chars, is the title; the rest the body; stage mist).

- Global hotkey "Clipboard to Inbox" (default Ctrl+Alt+Shift+V, configurable under Hotkeys…) does the same into the Inbox and shows "Added to Inbox: <title>". A registration failure shows in the Hotkeys dialog.
- Text over ~600 chars gets a "Split into cards" chip: local model, JSON-schema output `[{title, body, tags}]`, each card's words must be >= 80% from the source or it is dropped with a warning. Results are ghost cards linked "split from" the original, which stays. "Think harder" asks Claude; nothing escalates without a click.
