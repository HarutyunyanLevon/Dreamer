Dreamer: Built stage and build status coming back from the repo. Be terse. Read the stage type/filter/labels/colors, card view + editor, the QUESTIONS.md watcher/parser (round 3 prompt 7) and the handoff writer for the repo CLAUDE.md block. Add Rust tests for the STATUS parser, dirty detection and link.json. No summaries/screenshots.

Stage
- New stage after dream: id "built", label "Built". Dot #7fcfae. Look: crisp like Dream (CSS, not the edge shader) with a mint glow and a small check glyph in the header. Add it everywhere stages are listed (filter pill, editor, tool schemas, system prompt, handoff stage checkboxes, skill/bundle docs).
- Card frontmatter build?: {status: queued|in-progress|built|partial|blocked, task?, commits[], files[], evidence[], notes?, built_at?, snapshot_hash?, dirty?: bool, history: [{at, status, source}]}.
- When a card becomes built (from STATUS or manually choosing Built): write cards/<id>.built.md = snapshot of the saved card (title, body, tags, fields), set snapshot_hash, dirty=false.
- Drift: on every save (and on external file change) compare the saved content hash with snapshot_hash -> dirty. Reverting clears it. Dirty card keeps stage built and shows an amber (#f0a24a) ring on its dot + pill "Needs rebuild". Drafts don't count, only saved content.
- Queued / in-progress: small lilac bar at the card bottom (in-progress shimmers, CSS).
- Card editor gets a "Build" tab (only when build exists): status + history, task file link (open), commits (copy hash), files (open in VS Code via `code` if on PATH, else reveal in Explorer), evidence gallery (images/GIFs), notes, "Diff since built" (snapshot vs saved, util/diff.ts), and "Mark as built now" / "Clear needs rebuild" (undoable).

Repo link file
- Per project with a repo (handoff_target, shown in the UI as "Repo"; add "Link repo…" to the project menu): Dreamer writes <repo>/.dreamer/link.json (atomic, debounced 5s on card changes, also on version switch, export, task save, run start):
  {dreamer:1, workspace, project:{slug,name}, version:{id,title}, versions:[titles], status_file:"docs/design/STATUS.md", tasks_dir:"docs/design/tasks", outbox:".dreamer/outbox", tags:[...], cards:[{id,title,stage,tags,frame,build_status,dirty}]}  (open version only).
- First time a repo is linked: confirm dialog also offers to add ".dreamer/" to the repo .gitignore (default on).

STATUS.md
- Format, written by Claude Code (document it in docs/status-format.md):
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
  Lenient: key order free, missing keys fine, extra keys kept as notes, unknown status -> warning.
- Watch it like QUESTIONS.md (ignore our own writes). On change, diff against the last parsed state (<project>/build-sync.json) and apply only changed entries:
  - Known card id (any version, prefer the version in its task file, else open version): update build (status, commits, files, notes, history). built/partial -> stage built + snapshot (partial shows a half-mint dot and stays dirty=false). in-progress -> build.status only. blocked -> red-ish note in the Build tab + entry in the "From Claude Code" questions card.
  - Evidence files: copy into the project media/ (keep a repo path reference) and attach to the card's Build tab.
  - "new · …" entries: ghost card (night glass) with stage built and the build block, inside a frame "Built outside Dreamer" in the open version. Keep/Dismiss as usual. A dismissed entry never comes back (remember its title+files hash in build-sync.json).
  - A short line in the project chat: "Build update: 3 built, 1 new, 1 blocked" with jump links.
- Dreamer never edits STATUS.md except to create it (empty template) when a repo is linked.

Handoff CLAUDE.md block (update the generator)
- Add rules: after finishing work for a card, update docs/design/STATUS.md (format above, card ids from the task file or .dreamer/link.json); log features you built that have no card as "## new · <title>"; put screenshots/GIFs you produce in docs/design/evidence/; questions still go to QUESTIONS.md; commit messages start with [dreamer:<card id>] when the commit belongs to one card.
- Handoff export and gap check treat built cards as existing features (the GDD marks them "Built"; the roadmap skips them unless dirty, which becomes a change task).
