Dreamer: .dreamer.md bundles, import, and cards from the clipboard. Be terse. Read the card storage + ghost-card + proposal (cards/<id>.proposal.json) code, the canvas paste/drop/context-menu handlers, quick capture + global hotkey registration, the web-clip fetcher, the Inbox, and the local-model structured-output helper from the reliability work. Add Rust tests for the parser. Write the spec to docs/bundle-format.md.

Bundle format (v1), UTF-8, LF or CRLF, optional BOM:
  ---
  dreamer_bundle: 1
  bundle_id: <stable string; same id when a bundle is re-sent>
  title: <short label>
  project: <slug or name>      # optional, default = open project
  version: <version title>     # optional, default = open version
  frame: <frame title>         # optional default frame for all cards
  source: claude.ai | claude-code | dreamer-scan | other
  created: <ISO time>
  ---
  <!-- card -->
  ---
  ref: <unique within bundle>
  id: <existing Dreamer card id>   # optional: becomes an update proposal
  title: ...
  stage: mist|reverie|lucid|dream|built   # default mist
  tags: [..]
  frame: <frame title>             # optional, overrides header
  links: [{to: <ref or card id>, label: ...}]
  fields: {..}                     # optional
  build: {status: built|partial, files: [..], commits: [..], notes: ..}   # optional
  ---
  <markdown body until the next "<!-- card -->" line or EOF>
Lenient parse: strip a surrounding ```dreamer / ```markdown / ``` fence; ignore unknown keys (keep them as warnings); unknown stage -> mist + warning; duplicate ref -> rename + warning; links to unknown refs -> dropped + warning; YAML errors in one card -> that card skipped + warning, rest imported. Detection: text whose first non-blank line (after an optional fence) is "---" and whose header has dreamer_bundle.

Import pipeline (one Rust command parse_bundle -> ImportPlan, one apply command)
- Resolve target: project by slug/name (case-insensitive) else open project; version by title else open version; frames by title on that version's root canvas (create missing frames, placed to the right of existing content). Unresolved project/version -> the preview asks.
- Per card: id given and exists -> update proposal (existing proposal flow; build block shown as part of the diff). Else bundle_id+ref matches a card's import {bundle_id, ref} -> update proposal (or replace the ghost if still a ghost). Else new ghost card (night glass) with import {bundle_id, ref}, source from header.
- Placement: deterministic grid (reuse the organize layout helper), at the paste/drop point or inside the target frame; never overlapping.
- Kept cards with stage built / build block get build info (prompt 3 handles it; until then store build in frontmatter as-is).
- Preview dialog (glass): title, source, target pickers (project / version / default frame), list of cards with badge New / Update / Replace ghost, warnings (collapsible), Import button. After import: toast "7 cards imported as suggestions" with Keep all / Dismiss all / Undo; a pill on the canvas while ghosts from this import remain.

Ways in
- Ctrl+V on the canvas (not while typing in a field): bundle -> preview. See clipboard below for other types.
- Drag a .dreamer.md (or .md that detects as a bundle) onto the canvas -> preview, placed at the drop point.
- Sidebar project menu + canvas context menu: "Import bundle…" (file picker).
- Watched drop folders: <workspace>/import/ and, for each project with a repo (handoff_target), <repo>/.dreamer/outbox/. A new *.dreamer.md shows a toast "Import 7 cards from <source>?" (Preview / Later). After import or dismissal move the file to an imported/ subfolder next to it (never delete). Files that arrive while the app is closed are offered on next start.

Clipboard cards
- Smart paste on canvas, order: bundle -> image data (save to media/, image card) -> files from Explorer (images -> image cards, .dreamer.md -> import; others ignored with a toast) -> a single URL line (web clip card via the existing clip fetcher) -> text (first line, max 80 chars, = title; rest = body; stage mist). Pastes at the cursor (or viewport centre). One undo step.
- Context menu on canvas and frames: "New card from clipboard" (same logic). Quick-capture popup: Ctrl+V / a small "Paste clipboard" button fills it.
- Global hotkey "Clipboard to Inbox", default Ctrl+Alt+Shift+V, configurable next to the quick-capture hotkey; show an error in settings if registration fails. Works with the app in tray. Creates the card in the Inbox with the same type logic and shows a small toast "Added to Inbox: <title>".
- Long text: pasted text over ~600 chars becomes one card with a chip "Split into cards". It runs on the local model with JSON-schema output [{title, body, tags}]. Instruction: split only the user's text, no new ideas. Validation: each body's words must mostly come from the source (>= 80% of tokens), otherwise drop that card with a warning. The result is ghost cards around the original, linked "split from"; the original stays. The chip menu has "Think harder" (Claude). Never escalates without a click.
