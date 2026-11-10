# Dreamer: prompt for the next session

Paste everything below the line into a fresh Claude Code session opened in `D:\Projects\Dreamer`.

---

You are continuing to build **Dreamer**, a desktop app for collecting, linking and deepening game ideas (first use case: a chaotic-but-chill "fish-punk" fishing game). Tauri 2 + React + TypeScript + Vite, Rust core, plain-file workspace, Claude via the locally installed Claude Code / Agent SDK (no API key).

**Steps 1-3 of the build order are done.** Continue with **step 4** and go on through step 9, committing after each step. Do not ask me questions unless something blocks you; decide yourself and log decisions in `docs/decisions.md`. After each step tell me in two lines what works and what is next.

## Read first (in this order)
1. `NEXT_SESSION_PROMPT.md`: the original full brief. Its sections 2-9 (visual direction, product decisions, data layout, sidecar, themes, branching/compare/trash, build order, definition of done) stay authoritative.
2. `docs/decisions.md`: what was decided so far (step 3 section explains the storage design).
3. `docs/testing.md`: test plan so far.
4. `src-tauri/src/model.rs`, `storage.rs`, `commands.rs` and `src/api/types.ts`: the contract between Rust and the UI.

## Start by checking the baseline (you have a real shell this time)
- `git status` / `git log`. Steps 2 and 3 may not be committed yet: if not, commit them as "Step 2: shell + theme system" and "Step 3: storage core". Fix `.gitignore` if build output shows up.
- `npm install`, `cd src-tauri && cargo test` (expect 17 passing), `npm run check:themes`, then `npm run tauri dev`. On Windows, verify the things I could not: commands round trip, the file watcher (edit a card `.md` outside the app and see it update), `fs::rename` over open files. Fix anything that fails and note it in `docs/testing.md`. In the earlier sessions I only had a Linux sandbox: Rust compiled and tested there, UI checked in headless Chrome with a mock backend, never in the real Tauri window.

## What exists
- **Shell + themes (done):** frosted sidebar/chat, canvas area with dotted grid driven by CSS vars `--pan-x/--pan-y/--zoom`, WebGL D2 shader (verbatim, 16% render scale, reduced-motion, hidden-pause, flat fallback), 4 built-in themes with cross-fade, `npm run check:themes` for contrast.
- **Storage (done, tested):** workspace at `%USERPROFILE%\Dreamer` (`DREAMER_WORKSPACE` overrides), Inbox + projects, cards as `cards/<ULID>.md` (frontmatter + markdown; id = file name; unknown keys preserved), `canvas.json` = viewport + positions (links live in card frontmatter), atomic writes, move-to-Trash delete with labels (`trash_card(reason)` ready for "lost to ..."), restore, empty, file watcher emitting `workspace-changed`.
- **UI data layer:** `src/api` (typed `Api`; real Rust commands inside Tauri, in-memory mock in a plain browser), `src/state/useWorkspace.ts` (projects, active project, live reload). Canvas currently renders cards read-only at stored positions; ghost cards' Keep/Dismiss already work; toolbar "Card" makes a placeholder "New idea" card.

## Next: do these in order
4. **Canvas:** infinite pan/zoom (drive the CSS vars, persist the viewport with `save_canvas`, debounced), drag cards (persist positions), add/edit cards (title, markdown body with a light renderer, tags, custom fields), links as plain lines with optional label (stored in frontmatter `links[]`, drawn on an SVG layer, add/remove UI), stage change with the stage look per card, working stage filter, zoom pill + fit, images (paste/drop into `media/`, new Rust command) and web-clip cards. Keep ~500 cards at 60fps (CSS transforms, memoised cards, cull off-screen cards, links layer redrawn only when needed). Design the **Undo stack (Ctrl+Z)** here as client-side inverse commands (move, edit, stage, link, create, delete->restore) so later steps just push entries.
5. **Quick capture:** `tauri-plugin-global-shortcut` (default `Ctrl+Shift+Space`, configurable and stored in `workspace.json`), a small always-on-top "Catch a thought" popup window (Enter -> Inbox Cloud card, Esc closes), tray icon with minimize-to-tray so it works while the app is hidden. Mind Tauri 2 capabilities for the second window.
6. **Claude sidecar + chat panel:** Node sidecar using the Claude Agent SDK, spawned by Rust, working dir = active project folder, stdio JSON lines both ways; streaming chat, in-process app tools (`list_cards`, `read_card`, `create_card` always `ghost:true`, `update_card`, `set_stage`, `link_cards`, `suggest_variants`, `export_brief`, `ask_user`), no delete tool, selected card as context on every message, `/grill-me` with ONE multiple-choice question at a time rendered in our chat UI and answers written into the card's notes immediately, friendly setup screen if Claude Code is missing or not logged in. Because the tools write the same plain files, the watcher already makes results appear live. Verify against my real installed, logged-in Claude Code.
7. **Branch / compare / trash:** fork badge, compare view with diff, pick winner (others -> `trash_card(..., "lost to <title>")`), Trash view in the sidebar with labels and the two-way restore choice, "Give me 3 takes" via `suggest_variants`, all undoable.
8. **Theme editor** (custom palettes, sliders, contrast warnings, `themes/<id>.json`, duplicate/delete, per-project override via `project.json`) and **Export design brief** for Pitch cards (button disabled with "Unlocks when the card reaches Pitch" before).
9. **Polish:** keyboard shortcuts, undo everywhere, empty states, reduced motion, error handling, performance pass with 500 cards, `cargo tauri build` producing a Windows installer (verify it installs and runs), final `docs/testing.md` with a note on anything not verified.

## Rules that still apply
- Fonts bundled (no CDN). Min touch target 44px, text contrast >= 4.5:1 (add new tokens to `check:themes`).
- Plain files only, no database. Atomic writes. Claude never deletes; only the user empties the Trash, with confirmation.
- Add tests for new Rust logic (`cargo test`), keep `npm run build` and `cargo check` warning-free.
- Update `docs/decisions.md` and `docs/testing.md` every step.
