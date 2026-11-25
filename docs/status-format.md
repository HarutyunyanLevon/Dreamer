# Build status (`docs/design/STATUS.md`)

Claude Code writes this file in the repo; Dreamer reads it and never edits it (it only creates it empty when a repo is linked).

```
# Build status
<!-- dreamer:status v1 -->
## <card id> · <title>
status: in-progress | built | partial | blocked
task: tasks/<file>.md
commits: <hash>, <hash>
files: <repo-relative path>, ...
evidence: <repo-relative image/gif>, ...
notes: <one line>
## new · <title>
status: built
files: ...
notes: <what it is and why it was added>
```

Card ids come from the task file or `<repo>/.dreamer/link.json`. `## new · …` logs a feature that has no card.

## Lenient parsing

- Key order is free, missing keys are fine, lists are comma separated.
- Extra keys are kept as notes (`key: value` lines). A wrapped `notes:` line continues the note.
- `in progress`, `in_progress` and `in-progress` are the same. An unknown status is ignored with a warning.
- A heading that is neither `<id> · <title>` nor `new · <title>` is skipped with a warning. HTML comments are ignored.

## What Dreamer does with a change

Dreamer keeps the last applied state in `<project>/build-sync.json` and applies only entries that changed.

| Entry | Effect |
|---|---|
| known card id, `built` | stage Built, build block updated, snapshot `cards/<id>.built.md` written, `dirty` cleared |
| known card id, `partial` | same, but never "Needs rebuild" (shown as a half-mint dot) |
| `in-progress` | `build.status` only (a lilac shimmer bar on the card) |
| `blocked` | `build.status`, and a line on the "From Claude Code" questions card |
| `new · …` | a ghost card in the frame "Built outside Dreamer" of the open version; Keep / Dismiss as usual; a dismissed entry (same title and files) never comes back |
| `evidence:` | images/GIFs are copied into the project's `media/` and shown in the card's Build tab |

A built card that is edited afterwards (title, body, tags, fields; saved content only) keeps stage Built and shows "Needs rebuild". Editing it back clears that. If STATUS.md says `built` again for a card that needs a rebuild, it counts as rebuilt only when its `commits:` changed; otherwise use "Mark as built now" in the Build tab.

## Related files

- `<repo>/.dreamer/link.json`: written by Dreamer (open version only): workspace, project, version, versions, `status_file`, `tasks_dir`, `outbox`, tags and `cards: [{id, title, stage, tags, frame, build_status, dirty}]`. Ignored by git when the link dialog's checkbox is on.
- Commits that belong to one card start with `[dreamer:<card id>]`; screenshots and GIFs go in `docs/design/evidence/`.
