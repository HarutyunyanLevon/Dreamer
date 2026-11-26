# Architecture

## Split plan (step 5, files over 600 lines at start; line counts before)

| File (lines) | Becomes |
|---|---|
| src-tauri/src/storage.rs (2025) | storage/{mod (helpers, open, settings, projects), chats, canvas, cards, media, trashbin, tests}.rs; import.rs, migrate.rs stay |
| src-tauri/src/sidecar.rs (1438) | sidecar/{mod, process, protocol, events}.rs |
| src-tauri/src/handoff.rs (769) | keeps only the pack |
| sidecar/claude-sidecar.mjs (2543) | sidecar/{main, turn, tools/*, prompts/*}.mjs |
| src/components/CanvasArea.tsx (1850) | canvas/{Canvas, CardView, FrameView, Links, Marquee, useCanvasInput, menus/*}.tsx |
| src/state/useWorkspace.ts (1424) | state/workspace/{index, cards, canvas, undo, trash, branch}.ts |
| src/components/ChatPanel.tsx (1131) | chat/{ChatPanel, MessageView, QuestionForm, Composer, verbs}.tsx |
| src/state/useClaudeChat.ts (623) | split only if it pays |
| src/styles.css (1402) | per-area css imported by modules |
| artifacts.rs 1407, search.rs 957, memory.rs 840, model.rs 809, claude_setup.rs 778, ctx.rs 650, organize_pipeline.rs 630, commands.rs 608 | left as is: single-purpose, not mixed |

Rules: move code unchanged, one group per commit, checks after each.
