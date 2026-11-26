# Architecture

Dreamer = Tauri shell (Rust core) + React UI + a Node sidecar that talks to the user's Claude Code. See `identity.md` for scope.

## Rust core (`src-tauri/src`)
- **storage/** — plain-file workspace. `mod.rs`: layout, atomic writes, settings, projects, project meta. `cards.rs`: card files, Claude edit proposals, frames, attachments. `chats.rs`: chat threads, one JSON per card. `canvas.rs`: positions and viewport. `media.rs`: media files and clips. `trashbin.rs`: delete/restore/empty. `migrate.rs`: old-layout migration (read-only fallback). `import.rs`: bundle import. `tests.rs`: storage tests. Called by `commands.rs`, `sidecar/protocol.rs`, `handoff.rs`.
- **sidecar/** — bridge to the Node process. `mod.rs`: `ClaudeState`, turns (`send_message`, interrupt, shutdown). `process.rs`: spawn, stdio, exit handling, watchdog. `events.rs`: lines coming from the sidecar, organize-pipeline registry. `protocol.rs`: tool requests answered against storage. Called by `commands.rs`, `memory.rs`, `handoff.rs`, `organize_pipeline.rs`.
- **handoff.rs** — the one export: scope resolution, the design-doc pack, writing it into a repo, the generation job. Not split further: it is only the pack.
- **commands.rs** — Tauri commands, thin. **state.rs** — `AppState`. **model.rs** — serde types shared with the UI. **error.rs**, **watcher.rs** (file watcher), **router.rs**/**ctx.rs** (what a chat turn sees), **search.rs**, **memory.rs** (project memory passes), **organize.rs** + **organize_pipeline.rs** (tidy plans), **artifacts.rs** (artifact cards, SpriteCook), **bundle.rs**, **claude_setup.rs** (find/check Claude Code), **credentials.rs**, **clip.rs**, **proc_guard.rs**, **sidecar_log.rs**. Single-purpose; left whole.

## Sidecar (`sidecar/*.mjs`, packaged by `scripts/build-sidecar.mjs`)
`main.mjs`: stdin dispatch. `io.mjs`: stdout lines, `requestTool` round trip to Rust. `turn.mjs`: turn state, limits, watchdog, `pump`. `session.mjs`: one Claude session per thread, options, eviction. `activity.mjs`: live tool labels, token tracker, turn queue. `spritecook.mjs`: SpriteCook MCP + credit cap. `jobs.mjs`: handoff, memory, summary and completion one-shots. `prompts/system.mjs`, `prompts/jobs.mjs`: prompt text. `tools/*.mjs`: chat tools, one file per kind (`index` assembles; `artifactSession` is the artifact thread's own server).

## UI (`src`)
- **components/canvas/** — `Canvas.tsx` (the canvas: camera, pointer, keyboard, paste/drop, menus wiring; the one big component), `CardView.tsx` (one card), `Links.tsx` (links, ghost links), `Overlays.tsx` (warnings, suggestions pill, text/clip prompts), `menus/canvasMenu.tsx` (right-click menu router + canvas/link/frame menus), `menus/selectionMenu.tsx` (card/selection menu).
- **components/chat/** — `ChatPanel.tsx` (panel, send, slash commands), `MessageView.tsx` (a message), `QuestionForm.tsx`, `Status.tsx` (credit ask, balance, model badge, context meter, model settings), plus the small menus/popovers already there.
- **state/workspace/** — `index.ts`: `useWorkspace`, the single hook holding project data, undo, canvas, cards, trash, branches, ghost links; `organizeSim.ts`: pure layout and organize preview. **state/useClaudeChat.ts**: chat transport. Public API is `useWorkspace()` / `Workspace`.
- **styles/** — nine css files imported in cascade order from `main.tsx` (base, panels, cards, dialogs, chat, canvas, attachments, kinds, menus-frames).

## Left over 600 lines on purpose (step 5)
`canvas/Canvas.tsx` (1318) and `state/workspace/index.ts` (1296) are single components/hooks whose parts share one closure (refs for the stable-props/memo trick, undo stack, viewport queue). Splitting them is a design change (a context object passed between hooks), not a move; deferred, see `ponytail:` comments. Rust files over 600 that are single-purpose are left whole.
