---
name: dreamer-cards
description: Make cards for the Dreamer idea app as a .dreamer.md import bundle. Use when the user asks to make, export or send ideas or cards to Dreamer, or to log a repo's built or existing features into Dreamer.
---

# Dreamer cards

Dreamer is the user's desktop idea canvas. It imports cards from a `.dreamer.md` bundle. Turn what the user gave you into one valid bundle and deliver it.

## Where the bundle goes
- **Claude Code in a repo:** if `.dreamer/link.json` exists, read it first. It holds the project, the open version, existing cards (ids, titles, stages, tags) and existing tags. Write the bundle to `.dreamer/outbox/<yyyy-mm-dd>-<slug>.dreamer.md`; Dreamer notices it and offers to import. Without link.json, write to the same path and tell the user to drag the file onto the Dreamer canvas.
- **Chat (claude.ai):** create a file `<slug>.dreamer.md` if you can make files, AND print the whole bundle in one ```dreamer code block. The user copies it and presses Ctrl+V on the Dreamer canvas.

## Format
```dreamer
---
dreamer_bundle: 1
bundle_id: combat-ideas-2026-11-24
title: Combat ideas
project: fish-punk
version: v2
frame: Combat
source: claude.ai
created: 2026-11-24T18:00:00Z
---
<!-- card -->
---
ref: harpoon-dash
title: Harpoon dash
stage: reverie
tags: [movement, combat]
links:
  - {to: reel-tension, label: cancels}
---
Throw the harpoon and yank yourself toward it. Cancels reel tension.

### Open questions
- Cooldown or resource?
<!-- card -->
---
ref: reel-tension
title: Reel tension
stage: built
tags: [fishing]
build:
  status: built
  files: [src/fishing/reel.cpp]
  notes: Tension bar with snap-on-overload.
---
Holding reel raises tension; past the red zone the line snaps.
```

Rules:
- Header first: `---`, `dreamer_bundle: 1`, then the other keys, then `---`. `project`, `version` and `frame` are optional; leave them out when unknown.
- Keep `bundle_id` stable: re-sending an updated version of the same bundle reuses it, so Dreamer updates those cards instead of duplicating them.
- Each card starts with a line `<!-- card -->`, then a YAML frontmatter block (`---` ... `---`), then the markdown body. Never put `<!-- card -->` inside a body.
- Card keys: `ref` (unique, kebab-case), `title` (required), `stage`, `tags`, `frame`, `links`, `fields`, `build`, and `id` (only to update an existing card).
- `stage`: `mist` (raw idea), `reverie` (explored a little), `lucid` (worked out with details), `dream` (ready to build, has acceptance criteria), `built` (exists in code; needs a `build` block). Default is mist.
- `links[].to`: a `ref` in this bundle or an existing card id from link.json. `label` names the relation (needs, part of, cancels, alternative to).
- `build`: `status` (built | partial), `files` (repo-relative), optional `commits`, `notes`.

## Writing good cards
- One idea per card. Make titles concrete and at most 60 characters ("Harpoon dash cancels reel tension", not "Idea 3").
- Body: short markdown. Say what it is, then why, then `### Open questions` if any.
- Only write what the user said or decided. Your own suggestions get stage `mist` and the tag `suggestion`. Never present a guess as a decision.
- Tags: lowercase, at most 4 per card, reuse existing tags from link.json.
- With 6+ cards, group them with `frame`.
- Updating an existing card: give its `id` and the full new body (the body replaces the old one). Dreamer shows it as a proposal.
- Built features (repo): stage `built`, describe what exists from the code, list the main 1-5 files. Use the existing card's `id` when one matches.

## Before delivering
- Check: the header has `dreamer_bundle: 1`, every card has a title, refs are unique, every link target exists, and the YAML is valid.
- Tell the user in one line: how many cards, the target, and how to import (it's in the outbox / press Ctrl+V on the canvas).
