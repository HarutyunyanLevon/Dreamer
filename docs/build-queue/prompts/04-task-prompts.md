Dreamer: "Make build prompt" for any card, selection, frame or version. Be terse. Read the handoff one-shot session code (model_export, read-only tools, write_design_doc), the proposal/flag UI, context menus and the repo settings. No summaries/screenshots.

Entry points
- Card / selection / frame context menu and chat chip: "Make build prompt". Version-level: Build board / Design view "Prompt for queued" and "Prompt for needs rebuild" (batch, see prompt 5).
- Scope = the chosen cards + their links one hop (as context only, marked "context, not to build").

Generation (one-shot sidecar session, Claude, model_export; never the local model)
- Tools: list_cards, read_card, view_attachment, read_design_doc(name) (latest revision of the open version, if any), and write_task(markdown, meta {title, card_ids[], flags[{card_id?, text}]}), called once.
- Instructions: source of truth = the cards; never invent features. The task must stand alone for Claude Code. Sections:
  1. Goal (2-3 lines)
  2. Context: repo CLAUDE.md and docs/design/ pointers (only those that exist)
  3. What to build, per card: what it is, the behaviour, edge cases, assets referenced
  4. Acceptance criteria: checkable bullets per card
  5. Out of scope
  6. Report back: the STATUS.md rules, QUESTIONS.md, and commit per logical step with [dreamer:<card id>]
- Rebuild cards (dirty): the APP inserts, verbatim, the diff between cards/<id>.built.md and the saved card under "Design change since last build". Claude writes the change task around it and lists the files from build.files as the likely places to change.
- Flags = thin spots (no acceptance criteria possible, contradictions, missing asset). Shown above the editor with buttons Open card / Grill this card (runs /grill-me on that card in its thread).

Preview dialog (glass, editable markdown with preview toggle)
- Header: title, card chips, version, model used. Flags list.
- Buttons:
  - Copy: full text before saving; after saving, a short reference ("Implement docs/design/tasks/<file>. Follow CLAUDE.md and the Report back section.").
  - Save task: writes <repo>/docs/design/tasks/<yyyy-mm-dd>-<slug>.md with frontmatter {dreamer_task:1, id, version, kind: build|rebuild, cards:[ids], created}. Needs a repo; if none, open "Link repo…" first. Sets the cards' build.status = queued and task = the path.
  - Run in Dreamer: saves first, then starts a run (prompt 5; disabled with a hint until it exists).
  - Open terminal: saves first, then `wt.exe -d "<repo>" claude "<short reference>"`; fallback `cmd /c start "" /d "<repo>" cmd /k claude "<short reference>"`. Toast if `claude` isn't on PATH.
- Saved tasks are listed in the Design view under "Tasks" (open, copy, run, mark done).
