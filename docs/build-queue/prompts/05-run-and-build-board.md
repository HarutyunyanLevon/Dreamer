Dreamer: run Claude Code on a task inside Dreamer, and the Build board. Be terse. Read the sidecar (Agent SDK query options, canUseTool usage for web turns, watchdogs from the reliability pass, proc_guard), sidecar.rs protocol, the chat panel tabs, the task files from prompt 4 and the STATUS watcher. Add tests for the permission rules and the git helpers (temp repo). No summaries/screenshots.

Run engine (sidecar "build" mode, separate from chat sessions, one run per repo at a time)
- query() with cwd = repo, settingSources incl. project (so repo CLAUDE.md + .claude settings apply), model = setting "Build model" (default sonnet; Claude only, never the local model). Prompt = the short reference to the task file.
- Permissions: permissionMode "default" plus canUseTool:
  - Auto-allow: Read, Glob, Grep, LS, TodoWrite, and Edit, Write, MultiEdit, NotebookEdit when the resolved path is inside the repo (no symlink escape); and Bash commands that are exactly git status / git diff* / git log* / git add <paths> / git commit -m ... (no --amend, no -a outside repo).
  - Ask: every other Bash command, WebFetch, WebSearch, and any path outside the repo. The Build panel shows the request: Allow once / Allow this command prefix for this run / Deny (with an optional reason sent back).
  - Always deny: git push, git reset --hard, git clean -f*, git checkout/switch to another branch, git branch -D, rm -rf outside the repo; Claude gets the reason.
  - A pending ask pauses the watchdog.
- Watchdogs: reuse the reliability watchdog with build limits: first event 120s; 90s between events, or 10 min while a tool (Bash) is running. Interrupt button. On stall: interrupt, kill the child, mark the run failed, and keep the branch.
- Git: before the run, require a git repo. Dirty tree -> dialog: Stash and continue / Continue anyway / Cancel. Create branch dreamer/<yyyymmdd>-<slug> from HEAD and record base. After the run, a summary card in the Build panel: result, commits (list), files changed (count + list), STATUS entries parsed, duration. Buttons: Show diff (file list + per-file diff via git diff base..branch, reuse util/diff.ts rendering), Merge into <base> (confirm; --ff-only, else a merge commit; never push), Open terminal here, Delete branch (confirm), Keep branch.
- Logs: <project>/builds/<run-id>.jsonl (events, no secrets) + <run-id>.json summary; the Build panel lists past runs.
- Cards in the running task: build.status in-progress (shimmer) until STATUS.md says otherwise. A run that ends with no STATUS entry for a card -> the summary flags "no status reported for <card>".

Build panel
- A "Build" tab in the right panel next to Chat: the current run (streamed steps: tool calls collapsed into lines, assistant text, permission asks inline), the queue, past runs.

Build board (per open version)
- View toggle in the title pill: Canvas | Board.
- Columns: Dream (ready, stage dream with no build) | Queued | Building | Built | Needs rebuild. "Show Lucid" toggle adds lucid cards to the first column. Cards are compact (title, tags, dot, task chip).
- Drag Dream -> Queued: build.status = queued (no task yet). Drag Built -> Needs rebuild: dirty = true (manual). Drag back to clear. Undoable.
- Queued column: "Build queue": generates one task per queued card (cards linked "part of"/"needs" inside the queue are grouped into one task), shows the previews as a list (each editable as in prompt 4), then "Run all": tasks run one after another on ONE branch for the whole queue, stopping on failure or Interrupt; a pending permission ask waits.
- Needs rebuild column: "Prompt for all" = one rebuild task covering every dirty card (prompt 4 rebuild mode).
- Card click opens the editor on the Build tab.
