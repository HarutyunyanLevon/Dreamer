# Testing

## Step 1 smoke test (manual, Windows)
1. `npm install`
2. `npm run tauri dev` : a 1440x900 window titled "Dreamer" shows the italic wordmark on a pink background.
3. `npm run tauri build` : NSIS and MSI installers appear in `src-tauri/target/release/bundle/`.

## Step 2 checks
Automated (any OS): `npm run check:themes` prints contrast ratios for each built-in theme and exits non-zero if any text pair is below 4.5:1.

Manual (Windows, `npm run tauri dev`):
1. Window shows a slowly moving pearl-pink background, dotted white grid, frosted sidebar (left) and chat panel (right), five demo cards (one dashed "Claude suggests" ghost card with Keep/Dismiss), title pill with stage filter on top, zoom pill bottom-left, toolbar bottom-center.
2. Click each of the four theme swatches in the sidebar: the background colors fade over about half a second and all text/buttons re-tint. Relaunch: the chosen theme is still active with no flash of Pink.
3. Click stage filters (Mist/Reverie/Lucid/Dream): matching demo cards hide and show.
4. Windows Settings > Accessibility > Visual effects > Animation effects off: the background becomes a still image (restart the app to be sure).
5. Minimize the window for a minute and restore: animation resumes without a time jump.
6. Resize to the minimum (1100x600): nothing overlaps.

## Step 3 checks
Automated (any OS): `cd src-tauri && cargo test` runs 17 tests: workspace layout, settings + corrupt-file backup, project slugs (Inbox reserved), path-traversal rejection, card file round trip (CRLF/BOM/unknown keys/`---` inside body), reconcile of externally added/removed cards, delete/restore/empty trash, atomic write, viewport save, watcher path classification, a real file-watcher event, and the JSON contract with the UI.

Manual (Windows, `npm run tauri dev`; workspace appears at `%USERPROFILE%\Dreamer`):
1. First launch creates `Dreamer\workspace.json`, `Dreamer\inbox\...` and `Dreamer\themes\`. The sidebar shows Inbox (no badge while empty) and an empty-state message on the canvas.
2. Click **Card** (toolbar): a "New idea" Mist card appears; a file `inbox\cards\<ULID>.md` exists and `inbox\canvas.json` has its position. The Inbox badge shows 1.
3. **New project** > type a name > Enter: it appears in the sidebar and is selected; `projects\<slug>\` has `cards`, `media`, `briefs`, `trash`, `project.json`, `canvas.json`.
4. Live reload: copy a card file within `cards\` (new name) or create `cards\01TEST.md` with `---`, `title: From outside`, `stage: reverie`, `---`, a body line. It appears on the canvas within about a second, no restart.
5. Edit a card file's `title:` in an editor and save: the title updates live. Break its YAML (`title: [oops`): a pill says "1 card file couldn't be read" and the app keeps working.
6. Theme: switch theme, quit, relaunch: same theme. Edit `workspace.json` `"theme": "gold-sky"` while running: the theme switches.
7. Ghost card: create `cards\01GHOST.md` with `ghost: true` and `source: claude`: it shows "Claude suggests". **Keep** removes the dashed look (file now `ghost: false`); **Dismiss** moves it to `trash\` (file appears there, `trash.json` has reason "deleted").

## Step 4 checks (Windows, real shell this session)
Automated: `cd src-tauri && cargo test` (18 tests, including the new `save_media`/`read_project_file` path-traversal test), `npm run check:themes`, `npm run build` (tsc + vite, warning-free), `cargo check` (warning-free).

Verified live with `npm run tauri dev` against a throwaway `DREAMER_WORKSPACE`:
1. The real Tauri command round trip: launching the app created `workspace.json`, `inbox/`, `themes/` on disk exactly as the Rust tests predict.
2. The file watcher: a card file written from PowerShell outside the app (`inbox/cards/01TESTEXTERNAL....md`) was reconciled into `inbox/canvas.json` with a new position within ~1-2s, with the app running — no restart needed.
3. The global hotkey registers without error at startup (no `[dreamer] could not register hotkey` line in the log).

Manual (not re-driven through the GUI this session, since there is no visual tool for the native WebView2 window — only Chrome-based browser automation is available):
1. Pan (drag empty canvas / wheel), zoom (Ctrl+wheel / zoom pill +−), Fit, and the stage filter should all feel the same as the step-2/3 pass since the pill and filter markup is unchanged.
2. Dragging a card, editing a card (title/body/tags/fields/stage), creating a link, pasting an image into the editor, dropping an image file onto the canvas, and the "Web clip" prompt all follow the same `ws.*` → `api.*` → Rust command path already exercised by `cargo test` for the card/media operations, and by the live round-trip check above for persistence — but the interactions themselves (drag, paste, drop) need a human pass in the actual window.
3. Ctrl+Z / Ctrl+Shift+Z: logic only, not re-driven live.
4. The global hotkey's popup, the tray icon, and minimize-to-tray behavior (closing the main window should hide it, not quit) need a human pass — I can confirm the shortcut *registers* and the window-close handler is wired, but not that pressing the hotkey from another app actually raises the popup, since that requires OS-level focus changes a terminal can't drive.
5. `fs::rename` over a file another program has an exclusive lock on (antivirus, Notepad) remains unverified — the atomic-write path (temp file + rename onto the target) avoids the common case of *writing* a locked file, but trash/restore rename the target path itself, which could still fail if something else has it open. This would surface as an error toast; no code change made without being able to reproduce the exact lock scenario.

## Step 5 checks (Windows, real Claude Code install, this session)
Automated/direct: `cd src-tauri && cargo test` (18 tests, unchanged), `cargo check`, `npm run build` — all clean with the sidecar wiring in place.

Verified against the real sidecar process (not mocked), run standalone with `node sidecar/claude-sidecar.mjs` piped from a small Node test harness, against the actual installed, already-logged-in Claude Code (no API key, no stub):
1. A plain chat turn: sent `{"type":"user_message", ...}`, received streamed `delta` events followed by `message_done` with a real session id.
2. The `create_card` tool: asked Claude to call it; got a `tool_request` line, replied with a fake `tool_response` (standing in for Rust), and Claude's final message correctly referenced the card as created and pending Keep/Dismiss.
3. The `ask_question` tool (`/grill-me`'s building block): asked Claude to create a card and then ask one multiple-choice question about it; got both the `create_card` round trip and a well-formed `question` event with 2 real, on-topic choices, in the same conversation.

Verified with `npm run tauri dev` (same real shell): the app starts and runs with the new `sidecar.rs` module, the tray, and the global shortcut all compiled in — no panic, no error in the dev log.

Not verified live this session: clicking through the actual chat panel inside the WebView2 window (sending a message, watching it stream, clicking a `/grill-me` choice chip, seeing the card update). There is no GUI automation tool for the native Tauri window in this environment — only Chrome-based browser automation, which can't exercise this because the real IPC bridge (`__TAURI_INTERNALS__`) only exists inside the actual window; opening the Vite dev URL in a regular browser tab runs the mock Claude API instead. The two halves that make up that path were each verified independently (above), and the plumbing between them (`claude_send` → `sidecar::send_message` → spawn/write → background-thread read → `emit("claude-event", ...)` ) is structurally the same pattern already proven live for cards (create/watch/reconcile in step 4), but a human click-through pass is recommended before relying on it.

Known gap, not yet fixed: a packaged build's chat panel will not be able to start the sidecar (see docs/decisions.md's step 5 "packaging gap") — `cargo tauri build` is step 9's job, and bundling the sidecar's own `node_modules` or a Node runtime needs to happen before then.

## Step 6 checks
Automated: `cargo test` (18, unchanged), `cargo check`, `npm run build`, `npm run check:themes` — all clean.

Verified against the real sidecar + real Claude Code (not mocked): sent the exact instruction text `ChatPanel`'s "Give me 3 takes" chip generates (with a fresh random `branch_group` and a fake `variant_of`), and confirmed all three resulting `create_card` tool calls carried the same `branch_group` value. Re-ran with different random ids to rule out a fluke; both runs grouped correctly.

Not verified live: the Compare view's diff rendering, the fork badge on a canvas card, and the Trash view's Restore/Empty buttons clicked in the actual window — no GUI automation tool for the native WebView2 window this session (see the same gap noted in steps 4 and 5). Each of these is built directly on calls (`ws.loseCard`, `api.restoreCard`, `api.emptyTrash`, `ws.updateCard`) that were themselves exercised live in earlier steps, and `diffLines`/`branchGroup` are pure functions with no I/O, but a human click-through is recommended before relying on the UI.

## Step 7 checks
Automated: `cargo test` — 20 tests (`custom_themes_roundtrip_and_skip_bad_files`, `brief_export_is_locked_until_pitch` added), `cargo check`, `npm run build`, `npm run check:themes` — all clean.

Verified with `npm run tauri dev` against a throwaway workspace: hand-wrote `themes/test-theme.json` into the running workspace from PowerShell; the app kept running with no error in the dev log (the file-watcher's classification of `themes/*` as scope `"themes"` was already covered by a Rust unit test, so this confirms the live path end to end at the filesystem level, not just the UI reaction to it).

Not verified live: opening the Theme editor and dragging its sliders/color pickers, opening the per-project theme picker popover in the title pill, and clicking "Export brief" on a Dream card inside the actual window. Same native-window GUI-automation gap as steps 4-6 — each of these is built on `saveCustomTheme`/`deleteCustomTheme`/`setProjectTheme`/`exportBrief`, which call straight through to the Rust functions covered by the new unit tests above.

## Step 8 checks
Automated: `cargo test` (20, unchanged), `cargo check`, `npm run build`, `npm run check:themes` — all clean after the undo/drag fix, Esc-to-close, and empty-state additions.

Found and fixed during this pass (not just "checked"): dragging a card never pushed an undo entry (see docs/decisions.md's step 8 entry for why). This was caught by reading the undo code path end to end, not by a test — there wasn't one covering drag-then-undo specifically, because it's UI interaction state, not something `cargo test` reaches. No regression test was added for it (it lives entirely in `useWorkspace`'s React state, not Rust), so a future change to the drag handler should be re-checked by hand: drag a card, Ctrl+Z, confirm it snaps back.

500-card performance: not measured with a live profiler (no GUI-automation tool for the native window, and no Chrome-extension connection available this session either — `tabs_context_mcp` returned "Browser extension is not connected"). The case for 60fps is argued from the code in docs/decisions.md's step 8 entry (reference-stable props under React.memo during pan/drag). A `?stress=1` flag on `npm run dev` seeds a 500-card project for whoever can run a live profiler next.

Not verified live: Esc closing each modal, Esc canceling Link-mode, the "no cards in this filter" empty state, and the capture popup's new inline error message — same native-window GUI-automation gap as every other step. These are all small, low-risk UI additions; a human pass is still worth doing before considering the app done.

## Not verified by the author
- Window minimize/restore, real GPU rendering nuances, and `tauri build`'s installers (not run this session; see step 9).
- The reduced-motion OS toggle (Windows Settings > Accessibility).
- The chat panel's, Compare/Trash views', Theme editor's, and step 8's live UI (see Step 5/6/7/8 checks above).
- Live 500-card frame-rate measurement (see Step 8 checks above) — argued from code, not measured.

## Step 9 checks (Windows, real shell this session) - final build verification
1. `cargo tauri build`: produced both `src-tauri/target/release/bundle/nsis/Dreamer_0.1.0_x64-setup.exe` (~2.0 MiB) and `.../msi/Dreamer_0.1.0_x64_en-US.msi` (~2.8 MiB). Clean release build, no warnings.
2. Installed the NSIS build silently into a throwaway directory (`Dreamer_0.1.0_x64-setup.exe /S /D=C:\DreamerInstallTest`): produced `dreamer.exe`, `uninstall.exe`, and the bundled `sidecar/claude-sidecar.mjs` resource.
3. Launched the installed `dreamer.exe` directly (pointed at a throwaway `DREAMER_WORKSPACE` via env var) - it created `workspace.json`, `inbox/`, `themes/`, `projects/` on first run, identical to every dev-mode run this session.
4. Wrote a card file from PowerShell into the installed app's running workspace - the live watcher picked it up and reconciled it into `canvas.json` with a position, same as the dev-mode watcher test in step 4. The app stayed up throughout (checked `Get-Process` before and after).
5. Closed the app and ran `uninstall.exe /S` - the install directory was removed cleanly.
6. The MSI installer was built successfully but not separately installed this session (NSIS install/uninstall was taken as representative; both bundles are produced from the same `dreamer.exe` + resources).

Known, documented gap (not fixed, scope decision - see docs/decisions.md step 9): the installed app's chat panel needs Node.js (with the Agent SDK reachable) on the end-user's machine, same as every other step's "Claude sidecar" caveat. Bundling the sidecar's own `node_modules` was attempted and reverted after it made the NSIS build impractically slow (~384MB / ~8,000 files) for a problem it would only have half-solved (a system Node runtime is still required either way).

## Final summary of what was not independently verified by a human/GUI pass
Everything under "Not driven live" / "Not verified live" in the Step 4 through Step 8 sections above shares one root cause: there is no GUI-automation tool for the native Tauri/WebView2 window in this environment, and the Chrome browser extension needed for `claude-in-chrome` was not connected this session. In every case, the underlying logic was verified by one or more of: a Rust unit test, a direct run of the real sidecar process against the real Claude Code install, or launching the actual compiled/installed binary and driving it through the filesystem (writes, the watcher, the real command round trip) from a real shell. The specific gap in each case is "a human has not clicked the button," not "the code has not been exercised." A full manual click-through pass - every toolbar button, every modal, drag, paste, drop, the global hotkey from another app, tray minimize/restore, and the reduced-motion OS toggle - is recommended before calling this done.

## Setup: in-app Claude sign-in checks
Automated: `cargo test` gives 31 passing, plus 1 ignored live test. New tests in `claude_setup::tests`:
- executable resolution: PATH wins; a short PATH still finds `%APPDATA%\npm\claude.cmd` and ignores the extensionless and `.ps1` shims next to it; the native installer is preferred over the npm shim; nothing found returns `None`; `npm.cmd` is found in `%ProgramFiles%\nodejs`; Unix candidates use bare names.
- `claude auth status` parsing (JSON signed in and signed out, `authMethod: "none"` mapped to no method, noise around the JSON, a plain-text fallback, unknown output returning `None`); `--version` parsing; ANSI stripping.
- failure wording (network, EACCES, cancel, fallback to the last output line, empty output); login-URL extraction limited to Anthropic hosts (including look-alike hosts being rejected); the not-ready → ready transition that restarts the sidecar fires once and not on first observation.

`cargo check` and `npm run build` are warning-free.

Verified live on this machine: `cargo test -- --ignored live_status --nocapture` (real Claude Code, real `auth status`) reported installed, version, path `...\AppData\Roaming\npm\claude.cmd`, `loggedIn: true`, method `claude.ai`. The same test binary run with PATH cut down to `C:\Windows\System32;C:\Windows` (simulating a GUI launch) still resolved Claude Code via the native installer fallback (`%USERPROFILE%\.local\bin\claude.exe`) and read the sign-in state correctly.

Not verified live, and why:
- **The `claude auth login` flow end to end** (browser opening, the "Waiting for browser sign-in..." state, Cancel, and the automatic re-check plus sidecar restart afterwards). Testing it means signing the developer's real account out, which this session deliberately avoided. Check by hand: run `claude auth logout`, open Dreamer, click **Sign in with Claude**, finish in the browser, and confirm the panel switches to chat within a few seconds and the first message works with no restart. Repeat, clicking **Cancel** mid-way, and expect "Sign-in was cancelled.".
- **The in-app `npm install -g`**: running it would reinstall or upgrade the developer's global Claude Code. Check on a machine (or VM) without Claude Code: click **Install Claude Code**, watch npm output stream into the panel, and expect the panel to move to the sign-in state when it finishes. Also check with the network off for the "Couldn't reach the internet" message, and with Node.js uninstalled for the "npm wasn't found" message.
- **The setup screen's visuals**: the Chrome extension wasn't connected this session. The browser mock can show both states without Tauri: `npm run dev`, then open `/?claude=missing` or `/?claude=signedout`. Its Install and Sign-in buttons simulate a job and then succeed.

## Retrieval: card search checks
Automated: `cargo test` gives 39 passing (8 new in `search::tests`), plus 1 ignored live test from the setup step.
- `folding_and_stemming`: accent and ligature folding; s/es/ing/ed/ies pairs meet at the same stem (game/games/gaming/gamed, running/runs, boxes, planned, falling, missed, stories, dragons); glass, bus, axis, ring, red and level42 are not over-stemmed.
- `scoring_prefers_title_then_tags_then_fields_then_body`: one word placed in each of the four places ranks in exactly that order with strictly decreasing scores, and a non-matching card is excluded.
- `accents_coverage_prefix_and_ghosts`: `CAFÉS` finds "Café crawl"; matching both query words beats repeating one word; a prefix finds "monster"; ghost cards are returned and flagged; an empty query or no match returns nothing.
- `snippet_centers_on_the_match`, `trashed_cards_are_skipped_and_scope_is_respected` (uses the real `Workspace::delete_card`).
- `index_updates_incrementally_from_dirty_marks`: a file changed without a dirty mark stays stale (proving searches don't rescan); after `mark_dirty`, exactly 1 file is re-parsed; added and removed files are picked up; switching roots clears the index.
- `related_finds_links_both_ways_and_shared_tags`, plus `find` and resolution of linked-card titles.
- `stress_500_card_seed`: mirrors the mock `?stress=1` seed (500 cards, 4 stages, every third tagged). Measured on this machine:

  | Build | Cold index build | Warm search | Search after one edit |
  |---|---|---|---|
  | Debug | 68 ms | 1.3 ms | 2.4 ms |
  | Release | 32 ms | 0.2 ms | 1.4 ms |

  It asserts one re-parse after one edit, that the limit is honored, and generous time bounds (warm < 100 ms, incremental < 200 ms). Run it with `cargo test stress_500 -- --nocapture` to see the timings.

`cargo check` (no warnings), `npm run build` (no warnings) and `npm run check:themes` are all clean.

Verified against the real sidecar and real Claude Code, with a small Node harness standing in for Rust and answering tool requests from 5 fixed cards:
- "Which of my ideas involve water?": Claude called `search_cards` before answering, retried with synonyms ("ocean sea river", then "underwater boat fish"), cited the cards by title, and said which searches came up empty. The sidecar emitted a `search` event for each call.
- `/related` on "Clockwork leviathan": Claude called `list_related`, then `search_cards` (scope project), then 3 `propose_link` calls, each with a 2–3 word label and a one-sentence reason. Each produced a `link_proposal` event, and it never called `create_card`.

Not verified live: clicking result chips, the camera pan, ghost-link Keep/Dismiss plus undo, and the Ctrl+K palette inside the real window. There's no GUI automation for the native WebView2 window, and the Chrome extension wasn't connected this session. To check by hand:
- Ask Claude about an idea, click a result chip, and expect the canvas to glide to the card and ring it.
- Open a card, click `/related`, and expect dashed accent links with Keep/Dismiss. Keep one, press Ctrl+Z (the link goes back to a ghost), then press Ctrl+Shift+Z.
- Press Ctrl+K, type, use ↑↓ and Enter, and try the This project / All toggle.
- Browser preview: `npm run dev` with `?stress=1` gives the mock Ctrl+K search a 500-card project to search.

## Fix pass 1: Scrolling checks
Automated: `npm run build` (tsc + vite, no warnings). `npm run check:themes` passes, including the new "scrollbar thumb on track (UI)" row (3:1); it failed at the first alpha and was tuned. No Rust changed in this section.

Manual checklist (native window, `npm run tauri dev`). Not driven by me, because I can't click in the native WebView2 window:
- [ ] Chat thread, card editor, trash list, Ctrl+K results, fork compare, sidebar project list (make 20+ projects), and setup log all show the same slim bar with the same width and colors. None has the old grey OS bar.
- [ ] Filling any of them from empty to overflowing makes no text jump sideways.
- [ ] Wheel over the chat panel or sidebar: the canvas never moves.
- [ ] Open the card editor (it sits inside the canvas element) and wheel over its body, its notes textarea, and the dimmed backdrop: the canvas never moves.
- [ ] Notes textarea scrolled to its end: further wheeling scrolls the editor dialog. The dialog at its end: nothing else moves.
- [ ] Wheel over the title pill, toolbar, zoom pill, or a ghost-link Keep/Dismiss pill: no pan.
- [ ] Wheel over empty canvas pans, Ctrl+wheel zooms. Wheel over a short card pans too.
- [ ] Theme switch: the scrollbar colors follow the theme.
- [ ] Esc with Compare forks open over the card editor closes only Compare.

## Fix pass 2: Cards checks
Automated: `cargo test` gives 41 passing, with 2 new tests. `model::card_size_and_z_order_roundtrip_and_sanitize` checks that legacy positions round-trip without the new keys, that clamping and `max_z` work, and that `back: false` isn't written. `storage::size_and_z_order_persist_through_save_trash_and_restore` checks that new cards stack upward, that a NaN height is sanitized to auto on save, and that trash then restore keeps size, z and `back`. `cargo check`, `npm run build` and `npm run check:themes` (2 new rows) are all clean. The markdown escaping fix was checked with a throwaway tsx script: the attribute-injection string renders inert.

Manual checklist (native window; not driven by me):
- [ ] Hover a card: corner and edge handles appear. Drag each of the 8 and check that the opposite edge stays put, the card can't go below 160×90, and neighbours don't move. Ctrl+Z restores the size, and Ctrl+Shift+Z redoes it.
- [ ] Reload the app (or look at `canvas.json`): the size persists as `w`/`h` on that card's entry.
- [ ] A new card with a long body grows to about 18 lines, then its body scrolls with the wheel; at the end of the body, the wheel pans the canvas. After resizing it taller, it no longer auto-grows when you add text.
- [ ] Click a card behind another: it comes to the front, and Ctrl+Z puts it back. Use ⋯ and right-click, then Send to back and Bring to front. Order survives a reload (`z`, `back` in `canvas.json`).
- [ ] Drag a small card completely inside a bigger card that is in front: the small one shows on top. Send the small one to back: now it stays hidden behind the big one.
- [ ] Card editor: the notes area is large. "+ More" is collapsed and shows custom fields and web clip URL with helper text. On a card with values, the count badge shows, and the toggle state is remembered when you reopen that card.
- [ ] Drag a card, then Ctrl+Z, then reload: the card is still at the undone position (regression check for the flush fix).
- [ ] `npm run dev` with `?stress=1`, Fit, then pan and drag: smooth. I didn't measure this here (no profiler on the native window).

## Fix pass 3: Housekeeping checks
Automated: `cargo test` gives 43 passing, plus 2 ignored live tests.
- `delete_project_removes_folder_refuses_inbox_and_clears_last_project`: the Inbox is refused (Invalid), an unknown slug is NotFound, `../inbox` is refused, the folder is gone, `last_project` is cleared, the project is no longer listed, and the Inbox is untouched.
- `chat_threads_are_per_card_files_and_reset_clears_one`: an empty default thread, a save/load round trip, the file at `inbox/chats/<id>.json`, reset clearing only that thread, reset being idempotent, and bad thread names (`../workspace`, `a/b`) being refused.
- `watcher::classifies_paths_and_ignores_noise` (extended): `chats/*.json` writes are ignored, a project whose slug is "chats" still counts, and deleting a whole project folder still reports that project.

`cargo check`, `npm run build` and `npm run check:themes` (new "white on danger button" row) are all clean.

File effects, checked live from the shell:
- **Recycle Bin.** `cargo test -- --ignored delete_project_recycles_live --nocapture` printed `recycled=true` for a throwaway project in a temp workspace. A PowerShell query of the Windows Recycle Bin (`Shell.Application` namespace 10) then listed `dreamer-recycle-test`, so the real Recycle Bin path works on this machine. That test folder is still in the Recycle Bin and is safe to empty.
- **Per-thread sessions against the real Claude Code** (a harness standing in for Rust, sending the exact `user_message`/`reset_thread` protocol):
  - Thread A was told the codeword PELICAN. Thread B in the same project didn't know it.
  - Thread A recalled it, and still recalled it after the sidecar process was killed and restarted with A's saved `sessionId` (resume works).
  - After `reset_thread` for A, it no longer knew it.
  - A bogus saved session id recovered to a fresh session and answered. This last case failed on the first run; it was fixed (the zero-turn error result before the throw) and re-run. All 5 checks passed.

Manual checklist (native window; not driven by me):
- [ ] Sidebar ▸ New theme: the dialog is large, like the card editor. Controls are on the left and the preview on the right updates live as you drag sliders and pick colours. Contrast warnings appear inside the preview. It stacks on a narrow window.
- [ ] Hover a project: a trash icon appears (always shown on the active row; there is none on the Inbox). Click it and the dialog shows the folder path and the Recycle Bin wording. Cancel does nothing. Delete moves the selection to the Inbox, and the project disappears from the list without an error toast. A "moved to the Recycle Bin" notice appears, and Explorer's Recycle Bin has the folder. Restore it from Explorer and it reappears in the sidebar live.
- [ ] Select card A and chat, then select card B: an empty, separate thread. Back to A: the A thread is intact. Deselect the card: the project thread. Restart Dreamer: all three threads are still there, and Claude still remembers A's context.
- [ ] Reset chat on A, then confirm: A's thread is empty, `chats/<A id>.json` is gone, and Claude no longer remembers it. B and the project thread are untouched.

## Fix pass 4: Claude chat checks
Automated: `cargo test` gives 44 passing, plus 2 ignored live tests. The new `search::project_context_is_compact_ordered_and_capped` covers:
- the exact format (newest first, `*` for ghosts, tags, stage) and the empty-project wording;
- 500 cards capped to 200 lines with "…and 300 more cards not listed.", and the newest card included;
- the character budget winning over long titles, and tags capped.

`cargo check`, `npm run build` and `npm run check:themes` are clean.

Verified against the real sidecar and real Claude Code. A Node harness sent exactly what Rust and the UI send (`[Project context]` + `[Selected card]` + message), answered each question with its first option, and appended Q/A to the notes like the UI does:
- **First run:** after Q1 the account hit its usage limit, but Q1 already showed the model writing a made-up "[Answer] …" after asking. The tool result was then fixed.
- **Second run:** 8 questions, one per turn, covering the 8 items in order. All neutral with no praise, ending in `create_card` "Spec: Clockwork leviathan" (tags spec/boss/water, stage lucid, linked "spec of" to the card, one section per item from the answers), and final chat text exactly "Proposed a spec card." The model still streamed a short "The next question is on the card above." after each question, which the UI already hid. The sidecar now drops it.
- **Third run:** all 7 checks passed: 8 questions, every turn question-only with no streamed text, no praise, spec proposed, spec linked to the card, the final line only, and a formal general reply with no exclamation marks.

`npm run tauri dev`, run against a throwaway `DREAMER_WORKSPACE`: the app started (the binary was already built) and created `workspace.json`, `inbox/` (cards, media, briefs, trash, canvas.json, project.json), `projects/` and `themes/`. There were no errors or warnings in the dev log.
- **Mishap on my first attempt:** my check found a Dreamer that was already running (the user's own session) and port 1420 already in use, and my cleanup force-stopped that running Dreamer. Writes are atomic, so files should be intact; at most an unsaved canvas move in the last 400 ms could be lost.
- **Second attempt:** its final cleanup was refused by the permission system. That throwaway instance may still be open and is safe to close.

Manual checklist (native window; not driven by me):
- [ ] Type a long message: the box grows line by line up to half the panel, then scrolls. Shift+Enter adds a line, Enter sends, and the box shrinks back to one line.
- [ ] Select a card and run /grill-me: each turn shows only a question card with options. There's no duplicate question text above it, and no "great choice" style text. Each click appends **Q:**/**A:** to the card's notes immediately, and Ctrl+Z undoes it.
- [ ] After the last item, a dashed ghost card "Spec: …" appears on the canvas, linked to the card, and the chat shows only "Proposed a spec card."
- [ ] Ask a general question: the reply is formal and short, with no exclamation marks.
- [ ] Ask "which cards mention water?" in a 300-card project: the answer reflects the project overview, and replies don't slow down noticeably (the overview is capped).

## Fix pass #3, second round
How it was checked: `npm run tauri dev` against a throwaway `DREAMER_WORKSPACE`, with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`. A Node script (Chrome DevTools Protocol, no extra packages) then sent real mouse, wheel and key input to the WebView and read the DOM. "Driven" below means checked that way in the real app with the real Rust core. "Manual" means it still needs your click-through, usually because it is OS-level (tray, native window focus, global hotkey) or visual judgement.

### 1. Popups isolate from the canvas
Driven (all pass): the editor renders in a layer that is a direct child of `<body>`. Dragging on a non-interactive label inside the editor scrolls the editor and does not pan. Dragging inside the notes textarea selects text, and the popup neither drag-scrolls nor pans. The wheel inside the editor and over the scrim does not pan. Ctrl+Z with the editor open does not run canvas undo. A click on bare canvas outside closes the editor and doesn't pan. After that, dragging on empty canvas pans, and a drag that starts on the title pill does not. Right-click on a card opens the menu in the layer, and an outside click closes it without panning.

Manual:
- [ ] Open a card and drag inside it with the mouse on the stage chips' gaps and on the "Notes" and "Tags" labels: the editor scrolls, and the canvas behind stays still.
- [ ] Select text inside the title input, notes and a tag input by dragging: normal selection, no scrolling jump.
- [ ] Theme editor: the sliders and colour pickers drag normally (no popup scrolling).
- [ ] With the editor open, click a card behind it, the sidebar or the chat panel: the editor closes and nothing else happens (no card opens, no project switches).
- [ ] Project title pill › Theme: the list closes when you click anywhere outside it.

### 2. Opened card fits the canvas area
Driven (all pass): with the editor open, its box was measured against the sidebar's right edge, the chat panel's left edge and the window height. At 1440x900 it's [256,16 → 1068,884] inside 240..1084. Then the viewport was emulated, without closing the editor, at 1100x600 ([256,16 → 728,584] inside 240..744, contents scroll) and at 1700x1000. In each case it's centred within 30px of the free area's middle. The emulated sizes resize the page viewport, not the native window.

Manual:
- [ ] Drag the native window down to its minimum (1100x600) with a card open: the editor shrinks with it and never runs under the chat panel or off the bottom.

### 3. Sidebar toggles
Automated: `storage::panel_visibility_persists_and_defaults_to_shown` (older files show both, round trip, unknown keys kept).

Driven (all pass): two tabs 30×52px, flush with both edges, with the tooltips "Hide projects (Ctrl+B)" and "Hide chat (Ctrl+J)". Clicking the left tab hides the sidebar (`visibility: hidden` after the slide), writes `show_projects: false` to the real `workspace.json`, keeps the tab at x=0, and flips its tooltip to "Show". Ctrl+J hides the chat and writes `show_chat: false`. The title pill re-centres at 720/1440 and the zoom pill moves to x=46. Both states survive a page reload. With the editor open, Ctrl+B and Ctrl+J resize it live, and it stays open and inside the free area.

Manual:
- [ ] The slide looks smooth, and with Windows animation effects off it switches instantly.
- [ ] Ctrl+J in the native window toggles the chat and does not open WebView2's downloads panel.
- [ ] Quit and relaunch: the panels come back as you left them, with no slide on startup.

### 4. Stage-based card borders
Automated: `check:themes` has a 3:1 border row per stage, and all themes pass.

Driven (17/17 pass, two consecutive runs; production build served on the dev origin, real Rust core). Checks: Mist has the SVG edge and no CSS border, Reverie is dashed, Lucid is thin solid, Dream is solid and thicker than Lucid (3px vs 1px), and Ghost is dashed with no mist edge. At zoom >= 1 in the Inbox the edge animates with `mist-puff`. Zoomed out below 50%, Mist uses the dotted fallback and its SVG is hidden. In the 500-card "Perf" project, animation follows the rule (zoom >= 0.5 and at most 60 clouds on screen). Panning frame times: 165fps at zoom 1, 111–129fps at 0.59, and 70–101fps at 0.29 with all 500 cards rendered; p95 <= 18.3ms in every case.
Not covered: the subjective look of the wobble, and a real GPU under other load. The frame-time test dispatches wheel events from page script (one per frame), which exercises the same handler as a mouse wheel.

Manual:
- [ ] Inbox with one card per stage: puffy Mist, dashed hand-drawn Reverie, thin Lucid, thick crisp Dream, dashed Ghost.
- [ ] A 500-card project: pan and zoom stay smooth; at zoom < 50% or with many clouds visible, the clouds stop wobbling.

### 5. Delete project dialog and other modals
Driven (52/52 pass, at 1440x900 and at an emulated 1100x600): five dialogs were checked: delete project (opened with a real click on the Perf row's trash icon, then cancelled with Esc; Perf still exists), web clip, trash, new theme and Ctrl+K search. Each one renders in a layer that is a direct child of `<body>`, not inside a panel. Each is between 420px and 90vw wide (delete 460, web clip 460, trash 480, theme 960, search 640), horizontally centred to the pixel, and inside the window; all except search are vertically centred, and search is top-aligned by design. Before the blur fix, a screenshot showed cards crisp behind the dialog and the sidebar, which is how the production CSS bug was found. After the fix, the built CSS contains the unprefixed `backdrop-filter` again.

Manual:
- [ ] Sidebar › trash icon on a project: a 460px dialog in the middle of the window (not a small box in the sidebar) shows the full folder path. The path only appears after item 8; before that, opening this dialog froze the Rust core.
- [ ] A packaged build (`npm run tauri build`): panels, pills and dialogs are frosted (blurred), not just translucent.

### 6. Bottom bar
Driven (51/51 pass): at 1100x600, 1280x800, 1440x900 and 1700x1000 (emulated viewport), each with panels shown and hidden, plus link mode at 1440. The zoom pill and toolbar never overlap (narrowest gap 12px, at 1100 with both panels and at 1440 in link mode), and both stay inside the free area. Each time, `elementFromPoint` at Fit's centre is Fit. Tools are 44px or more, zoom buttons exactly 32px, and every tool has an aria-label and a tooltip. Labels collapse to icons at 1100 and 1280 with both panels open, are shown at 1440 and up, and come back at 1100 when the panels are hidden. A real click on Fit moves the camera and creates no card.

Manual:
- [ ] Hover each icon-only tool at 1100px: the tooltip names it.
- [ ] The zoom buttons are comfortable to hit with a mouse at 32px.

### 7. No screen dimming
Driven (9/9 pass): for the card editor, the web clip dialog and the card menu: the scrim's background is `rgba(0, 0, 0, 0)` and no full-window element inside the layer has a tinted background, the popup has the 48px soft shadow, and a click on bare canvas outside still closes it. Item 1's checks were re-run after this change (all pass at 1440x900, and again at 1100x600 where the editor scrolls: drag-scroll moved it, max 106px).

Manual:
- [ ] Open a card, the trash, Ctrl+K and the card menu in each theme: no darkening, and the popup is still clearly separated from the canvas.

### 8. Project create/delete reliability
Automated (`cargo test`: 54 passed, 2 ignored live tests). New tests:
- `create_project_refuses_a_second_project_with_the_same_name`: case, spaces and "Inbox"; a different name with the same slug still gets `-2`.
- `concurrent_creates_with_one_name_make_one_project`: 8 threads on one `Mutex<Workspace>`, like the command layer.
- `delete_project_works_while_the_watcher_is_active`: a real `notify` watcher on the root, 3 rounds with writes just before each delete.
- `delete_project_clears_read_only_files`.
- `delete_project_retries_until_a_brief_lock_is_released` (Windows): exclusive lock released after 300ms; the delete waits and succeeds.
- `delete_project_leaves_a_locked_project_whole_and_says_why` (Windows): a lock held throughout gives an "in use … Nothing was deleted" error and every file is still there.
- `retry_io_gives_up_on_permanent_errors_at_once`.
- `workspace_info_reads_only_the_locked_workspace` and `no_command_touches_state_again_inside_with_ws` (the deadlock).
- `projects_get_unique_slugs_and_inbox_is_reserved` was updated deliberately: it used to assert that the same name twice is allowed.

Reproduced on the old code (real app): opening the delete dialog → `list_projects` timed out (deadlock). Create/delete with the watcher active ×6 and rapid create/delete ×5 all worked. The same name twice gave `twice` + `twice-2`.

Driven after the fix (all pass): the delete dialog shows the full folder path and Rust keeps answering. Enter creates exactly one project and selects it. The same name in another case shows "A project named “Item eight” already exists." inline, keeps the text and creates nothing. Esc cancels. Blur with a name creates once; blur when empty cancels. Enter + Enter + blur in one go create exactly one. Three projects were deleted through the real dialog (folders gone, Recycle Bin notice, Inbox selected), and a create right after works. With a separate PowerShell process holding `canvas.json` open exclusively: deleting via the dialog left the project whole (7/7 entries), still listed, with the real error in the toast. Once the lock was released, deleting worked and no `.deleting-` leftovers remained. A long, unbreakable toast message wraps inside the toast with Close inside it.

Manual:
- [ ] Delete a project whose folder is open in Explorer (just viewing it). It should either work (Explorer doesn't lock), or refuse with the "in use" message and leave the project whole.
- [ ] Restore a deleted project from the Recycle Bin: it reappears live.

### 10. Undo/Redo buttons
Driven (9/9 pass): both buttons are curved-arrow icons with aria-labels and `aria-keyshortcuts`. With no history, both show `aria-disabled="true"` at opacity 0.32 with a not-allowed cursor, and the tooltips "Undo (Ctrl+Z): nothing to undo" / "Redo (Ctrl+Shift+Z): nothing to redo". A real click on the disabled Undo does nothing. After a real card drag, Undo is active at full opacity with the tooltip "Undo (Ctrl+Z)"; a real click on it moves the card back, Redo becomes active, and a real click on Redo re-applies the move. Close-up screenshots of both states were checked.

Manual:
- [ ] Hover each button: the native tooltip shows the shortcut, also while dimmed.

## Round 3, step 6: handoff pack
- `cargo test`: new `handoff` tests cover version numbering (index, stray `v*` folders, corrupt index, no overwrite, no temp folders left), CLAUDE.md block replacement (absent / empty / no markers / present / idempotent / CRLF / three malformed shapes), the repo copy (only pack files replaced, CLAUDE.md not in docs/design, QUESTIONS.md never overwritten), `write_design_doc` name checks (and `read_doc`), scope resolution (stages, stickies, ghosts, role cards, two-step links, frames, selection) and gap normalization. Storage tests cover `handoff_target` (validation, confirm, clear, unknown keys kept) and the one-per-project `decisions` role.
- Sidecar driven directly against the installed Claude Code with a harness answering the `handoff_*` tools like Rust (model haiku, 2 cards): gap check reported all items in ~7s; generation wrote all 8 docs in ~20s with the requested roadmap/CLAUDE.md format; cancel 6s in ended with `cancelled` within 0.5s.
- Driven in the real app (`npm run tauri dev`, throwaway `DREAMER_WORKSPACE`, WebView2 over CDP, real Claude Code with `model_export`/`model_chat` = haiku). The seed project had 7 objects: a Lucid card, a Reverie card linked to it, a Mist card, the Tech card, a sticky, an image and a clip with a saved excerpt.
  - Summarize chip → dialog: all three scopes, 4 stage toggles on, stickies off, "6 cards in scope" (sticky excluded), model "haiku" shown.
  - Run gap check: 13 items back in ~15s with notes; "Fill with grill-me" and "Generate anyway" appear.
  - Repo folder set: the first Generate shows the "Write into this folder?" confirm; the second run (v2) doesn't.
  - Progress panel steps advance (Reading cards 6/6, Viewing images 0/1, Writing docs n/7, Copying), then "Design v1 is ready" + "Copied to …".
  - Disk: `design/v1/` has the 7 docs, CHANGELOG ("Initial version"), manifest (cards + updated, 13 gaps) and `assets/<id>.png`; `index.json` lists it. The image is embedded in 01-gdd.md with a description; the clip is in 05-assets.md References with a 2-point takeaway; the roadmap uses `M1-T1` + Acceptance / Relies on / Size; CLAUDE.md is 37 lines.
  - Repo: the pre-existing CLAUDE.md text was kept and one marker block appended (still one after v2). The existing QUESTIONS.md was untouched, and an unrelated `docs/design/keep-me.txt` was left alone.
  - v2 via Design › New version after editing the Mist card: CHANGELOG v2 names that edit.
  - Cancel 7s into a run: the panel closes, the toast says "Cancelled. Nothing was written.", and there's no v3 and no temp folder.
  - Design view: sidebar row with a version badge, doc tabs, version dropdown, the image rendered from `assets/`, Discuss with Claude → project thread with "About the design doc 01-gdd.md (design v1): " prefilled.
  - Fill with grill-me: "/grill-me on 11 gaps" in the project thread. Answering the first question created a non-ghost "Project decisions" card (`role: decisions`) holding the Q and A.
  - After stopping the app, no dreamer/node/claude process from it remained.
  - Found and fixed in this pass: the sidebar's Design row was squeezed into the project row's flex line, hiding both labels; it now wraps onto its own line. After a gap check with thin/missing items, the primary button now reads "Generate anyway".
  - Seen once, not reproduced: after the first generation the chat panel showed the sticky's thread although nothing had been clicked on the canvas. Closing the dialog and the progress panel were retried and both kept the project thread.
- Manual: Open folder (opens Explorer) and Copy Claude Code prompt (clipboard) weren't checked; the native folder picker ("Choose…") wasn't used, the target was set through `update_project`.

## Card editor stays open during chat; thread pin (not yet run in the app)

- Open a card (editor opens, scrim covers canvas + sidebar but not the chat). In the chat panel: click, type, scroll, answer a grill question, Keep a ghost card, click a result chip for the same card. The editor stays open throughout. Esc with the chat input focused only blurs it; Esc elsewhere still closes the editor.
- Click a result chip / ghost link for another card: with no edits the editor switches to it; with edits an inline "Switch to X? Your edits stay as a draft." appears (Stay keeps editing; Switch saves a draft, opens the other card, and reopening the first restores the draft).
- Pin: header pill shows "Project" or the card (stage dot); the pin toggle freezes the thread while selecting/opening other cards (pill shows a pin); unpin follows again. The pin survives a reload, per project, and is released when the pinned card is trashed.
- Window-placement dialogs (e.g. Reset chat, Theme) still cover the whole window.

## Round 3, step 8: project memory (manual, in the app)
Use a project (not the Inbox). `cargo test` covers parse/render, ops, log, revert, cap, card-decision lines.
- **Decision in chat:** in the project chat say "No PvP, ever." After the reply a faint line appears: "Memory updated: + Decisions: …" with Undo and Edit memory. `memory.md` has the bullet; `memory.log.jsonl` has an entry with source `auto`. Undo: the bullet is gone, the line says "Memory change undone".
- **Brainstorm, no decision:** ask "give me ideas for bosses". No memory line, `memory.md` unchanged.
- **Chips:** /expand, /critique, /describe, /related, Give me 3 takes, a merge: no memory pass (nothing in the log). A grill-me answer you pick: may add a line.
- **Card chat:** open a card, state a decision about it ("this boss has three phases"). The card shows the Claude-suggests badge; its diff adds a `## Decisions` section with the line. Undo on the chat line removes it (and the proposal). Keep applies it to the card.
- **Explicit:** "remember: the demo is 10 minutes long" saves immediately (log source `claude`, same chat line). "forget the demo length" removes it. "Remember" in the Inbox: Claude says there is no project memory.
- **Cap:** set Models > Project memory cap to 30; keep stating decisions: later ones are skipped (not an error in chat); in the modal Save is disabled while over the cap.
- **Memory modal:** open it from the chat header and from the sidebar row. Edit a section, Save: log source `user`. History tab: Revert on an old entry removes just that entry's lines. Edit memory.md in an editor while the modal is open and untouched: it reloads.
- **Bootstrap:** a project with 3+ kept cards and no memory.md: on opening it the modal shows a draft (needs Claude signed in). Keep / Edit→Save / Start empty each create memory.md; reopening the app does not ask again. Close without choosing: nothing is written.
- **Handoff:** with a Decisions line "no multiplayer", run Gap check and Generate: the docs treat it as settled, and `design/vN/manifest.json` has `memory_hash`.
- **Long session:** keep chatting until the "Earlier messages summarized" divider appears; the memory block is still sent with the next message (and a memory edit made meanwhile arrives as "Project memory updated").

## Live activity: steps, tokens, stalls (browser preview + app)
Browser (`npm run dev`, mock): any chat message plays a scripted turn; a message containing "stall" goes silent once.
- **Long multi-tool question** (app: "compare my market cards and look at their images", web on): while it runs, a step list grows under the turn: spinner on the running step, ✓ when done, red dot on an error (mock: the second read). A thinking step reads "Thinking… Ns" and expands on click to the streamed text (collapsed by default). The status line below shows the current step (or "Writing…" while text streams, "Waiting for Claude…" before the first event) · mm:ss · ↑ input (cached part muted) ↓ output, with numbers rising. The reply text streams below it.
- **Done:** the steps collapse into one faint line above the reply, e.g. "5 steps · 18s · ↑ 12.3k ↓ 640"; clicking it shows the steps again. Reload / reopen the thread: the line is still there (steps, usage and durationMs are in the thread file; thinking text cut at 2,000 chars).
- **Memory pass:** after a normal turn, "Updating memory… ↑ 1.2k" appears under it and disappears; "Memory updated" still shows when something changed.
- **Grill-me (quiet):** same steps and status line, no streamed text; then the question card.
- **Context meter:** after a turn the chat header shows "34k / 200k" with a thin bar; tooltip explains auto-summary. Set Settings › "Summarize a thread after" just above the current count: the meter turns amber (from 80%). Reopen the thread: the meter is read from the thread file.
- **Compaction:** with that setting low, the next turn first shows "Summarizing earlier messages…" with its own tokens, then the turn's steps.
- **Stall:** send "stall test" (mock) or, in the app, block the network mid-turn. After 45 s with no event the status line turns amber, "No activity for 45s", with Stop and Retry. Stop ends the turn. Retry stops it (closing its Claude session) and sends the same message again in the same thread; the reply arrives normally.
- **Errors:** kill the sidecar's node process mid-turn: the turn turns red with Retry right away. An `error` reply also has Retry.
- **Handoff:** gap check and Generate show the same step list + status line (Read "…", Wrote 01-gdd.md, tokens, elapsed); the stall warning appears after 45 s idle; Cancel still works.

## Packaging 0.2.0 (installed app)

Done this session:
- `npm run build:sidecar`: `src-tauri/sidecar-dist` is ~11 MB (SDK 0.3.322, zod 4.6.7, no bundled claude.exe). Inside it, `import('@anthropic-ai/claude-agent-sdk')` and `zod/v4` load (`query`, `createSdkMcpServer` are functions).
- `npm run icons`: source.svg → 1024 PNG → `tauri icon`; the 32px icon and the 16/32px tray pearl are legible.

Not run yet (the session's shell stopped accepting commands before the build):
1. `npm run release` prints `src-tauri/target/release/bundle/nsis/Dreamer_0.2.0_x64-setup.exe`.
2. Rename `node_modules` → `node_modules.off`; install the exe; launch from the Start menu; send a chat message (the reply arrives, Dreamer tools work). Rename it back.
3. Pin to taskbar, close to tray, click the pin: the same window shows, one `dreamer.exe` in Task Manager, one taskbar button (pin, window and autostart launch grouped).
4. Icon is the pearl in the taskbar, Start menu, tray, Alt+Tab and on the installer exe.
5. No desktop shortcut after install.
6. Run the installer again while Dreamer runs: it closes Dreamer, updates, and the workspace (`%USERPROFILE%\Dreamer`) is intact.

## Artifacts (0.4.0)
Automated: `cargo test` (`artifacts::tests`: create + folder; versions never overwritten, v2 starts as a copy of v1, meta.json credits and jobs; approved files kept; file-name checks; two themes, active switch, per-artifact theme and art-mode override, CSS tokens, bad input refused; sandboxed HTML bundle (CSP first, local files inlined including CSS `url()`, remote refs left, theme tokens); copy_asset; SpriteCook project id; chip count; handoff takes only approved versions + the style guide. Also `credentials` masking and the watcher's `artifact` scope). The sidecar was checked standalone: it starts and answers `spritecook_balance` with `no_key`; against a fake streamable-HTTP MCP server it runs initialize, keeps the session id, parses the SSE reply (`credits: 3696`) and closes the session. `npm run build` and `npm run check:themes` pass.

Not verified by the author: anything against the real SpriteCook account (no paid calls were made), Claude's judgement in artifact turns, and the UI itself (the browser extension wasn't connected, so not even the mock preview was looked at). One `cargo test` failure was seen once and didn't reproduce in 5 reruns (most likely an existing timing-sensitive test).

Setup:
1. Settings › SpriteCook: paste a key and Save. "saved: sc_••••abcd" shows; the key is in Windows Credential Manager (generic credential `spritecook-api-key` / `app.dreamer.desktop`) and appears nowhere under the workspace or in sidecar.log. "Remove saved key" clears it.
2. The composer shows `◈ <credits> cr` next to the model chip; a click refreshes it. Without a key the chip is hidden.

Done-when checks:
3. **Visualize → Character:** right-click a plain idea card › Visualize… › Character. An artifact card appears to its right, linked ("visualizes"); the chat opens its thread and the badge says Claude. The card shows "Claude is working…" with a progress bar, then the hero image, v1 and 2-5 chips (e.g. Turnaround, Angry expression, Animate idle). Double-click: hero + design notes (bio, silhouette, palette, personality) and the brief with the prompts sent. No turnaround or expressions were made.
4. **Chip:** click "Turnaround": one Claude turn; the turnaround appears next to the hero in v1 (mode add) and the chips are replaced.
5. **Local escalation:** with local chat on, ask in a card's chat "make concept art of the rust docks". The local reply says Claude is making it; a concept artifact card appears and its first turn starts once the local turn ends, with "Recapped the thread (local model)". sidecar.log: the local session's init lists no `mcp__spritecook__*` tools.
6. **Themes:** create two themes (New artifact › Theme); each gets a palette, fonts, key art, a preset and a style-guide page. Card menu › Set as active theme on A: a new character's theme pill says A. Switch to B: the next new artifact says B. In a character's full view pick theme A and art mode "Pixel 16px": its pills show A and Pixel 16px, and its next turn uses them.
7. **Mockup:** New artifact › Mockup ("inventory screen using the fish priest sprite"). The card shows a small live thumbnail; Open full size runs it (clicks work). DevTools on the iframe: no network requests; an added `fetch("https://example.com")` fails with a CSP error. Sprites load from `assets/`. Ask for "use a SpriteCook UI kit": its components show as 9-slice frames.
8. **Cap:** Settings cap = 1, ask a character for "three expressions". After the first paid call the reply shows "This turn used 1 of 1 paid SpriteCook calls. Generate 1 more (~X credits)?". Stop here: Claude wraps up without more images. Allow: it continues. The balance refreshes after the turn; `v<N>/meta.json` has credits and job ids.
9. **Feedback:** in the artifact's thread write "bigger hat": v2 appears (parent 1) and v1's files are unchanged on disk; full view › Compare shows v1 and v2 side by side.
10. **Handoff:** approve v1 of the character only and generate the pack: `design/v<N>/assets/<character-slug>/` holds v1's files, and 05-assets.md ends with "Artifacts (approved)" (only that one) and "Style guide: <active theme>". Unapproved artifacts are absent, and artifact cards don't count in the scope.
11. **No key:** remove the key, then create a theme and a mockup: spec, style-guide page and mockup HTML are made; the turn shows "No SpriteCook key: image steps were skipped…" with a Settings button; a character's card shows "Images need a SpriteCook key: Settings".
12. **Ghost artifact:** /grill-me on a card about a character's look: Claude may propose a ghost artifact (brief only, Claude-suggests style). Dismiss: nothing spent. Keep: its first turn starts.
13. Trash an artifact card and restore it: the previews come back. Empty the Trash with it inside: `artifacts/<id>/` is gone.

## Question checklists (branch `reliability`)
`npm run test:checklist` (parseItem / grouping); `cargo test dismissed_design_question_is_not_reimported`. The browser preview's Fish-punk project has a seeded "From Claude Code" card.

Manual:
1. A long Claude Code question wraps (long words too) and the card grows; links and frames follow. Dragging a side handle changes the width only; there are no top/bottom handles.
2. Items show under a header with the card's title ("Fish that fight back"); an unknown id shows `…` + its last 5 chars. The context shows as a small grey line and is not editable on the canvas.
3. Enter in an item adds one below, Shift+Enter adds a newline, Esc reverts, Backspace on an empty item removes it; Enter in an answer commits.
4. Open the card: the items are under the title, above Notes, with roomy answers; the context is editable in the item text.
5. Answer a question: it moves into "1 answered ▸" (closed). Delete it with ×: it appears on Project decisions as **Q:**/**A:** (the card is created when missing); one Undo restores the item and the decisions text.
6. With two answered questions, "Clear answered" (fold header, then the card menu): both go to Project decisions in one append; one Undo restores both.
7. Delete an unanswered "From Claude Code" item, then add a line to QUESTIONS.md: the new line is imported, the deleted one is not, and QUESTIONS.md itself is unchanged by the delete.

## Grill-me in batches (branch `reliability`)
Manual:
1. /grill-me on an idea card: one form with 3-4 questions, the recommended chip first with a "Recommended" tag, context as a grey line. Send stays disabled until each question is picked, has Other text or is skipped. Send: one user message of Q:/A: lines; every answered pair lands in the card's notes; one Ctrl+Z removes them all.
2. "Other…" shows a text box (Enter picks it); Skip greys the question and it is sent as `A: (skipped)` and not written to the notes. Ctrl+Enter sends. After Send the form is read-only and shows the choices.
3. Click "? N" on the From Claude Code card (or "Answer with Claude" in its editor, or the /grill-me chip in its thread): a form with its open questions. Send: the item answers are filled and QUESTIONS.md gets `[x]` + `A:` lines; skipped items stay open. When none are left the reply is exactly "All open questions covered."
4. An old thread with single questions still renders them (answered ones read-only with the chosen chip).
## Strip-down step 1: one canvas per project
Automated: `cd src-tauri && cargo test migrate` (fixture with versions + nested folders + Inbox: one canvas each, frames with the right members, archive present, links intact; second run is a no-op; a re-run after a crash doesn't double frames; overlapping tiles go in a row; on Windows, a locked file makes the backup fail and leaves everything untouched and read-only). `cargo test bundle` covers `version` ignored / `folder` as frame. `npm run build`.

Manual migration check (Windows): copy a real layout-1 workspace somewhere, run with `DREAMER_WORKSPACE` pointing at it.
1. A `.backup-<date>/` folder appears beside `projects/` with a full copy; `migration-2.log` lists what moved.
2. Each project opens on one canvas; former folders are frames titled with their path; former extra versions are under `projects/<slug>/archive/versions/`.
3. The old Inbox is the project "Inbox" (`projects/inbox-ideas`).
4. Relaunch: no second backup, nothing changes.
5. Lock a card file (e.g. open it with exclusive access) in a fresh layout-1 copy and launch: the top banner says "Read-only. Migration failed, your data is untouched: …" and edits fail; nothing on disk changed.

## Strip-down step 2: removed features
Automated: `cd src-tauri && cargo test` (all pass), `npx tsc --noEmit`, `npm run build`, `npm run test:reliability`, `npm run test:checklist`, `npm run check:themes`. New: `storage::migrate::tests::step_f_converts_stickies_labels_and_the_questions_card_once` (sticky/label/cc-questions/build-block conversion, idempotent), the handoff pack tests (`write_pack` replaces only its own files, twice in a row), bundle import ignoring a `build:` key.
Manual (Windows, `npm run tauri dev`), checks that need the real window:
1. Closing the window quits the app (no tray icon, no hotkey registered: Ctrl+Shift+Space does nothing).
2. Open an older workspace with stickies, labels, a "From Claude Code" card and built cards: they open as plain Mist cards / a plain checklist, `built` cards keep their stage with no build badge, and `workspace.json` gets `"stripped": true`.
3. Summarize: choose a repo folder, Generate; `docs/design/*.md`, `manifest.json`, `assets/` and the Dreamer block of `CLAUDE.md` appear, and a second run overwrites them. With no repo folder the Generate button stays disabled.
4. The sidebar has Memory, Import bundle… and Link repo… only; the canvas menus have no gap check, scan, build prompt, sticky or label; Settings has no hotkey, autostart, local model or build model fields.
5. A chat turn, /organize and /grill-me still run (Claude only); a stalled turn still offers Stop / Retry.
Not run in this session: the live window (the Tauri window cannot be driven here) and any real Claude turn after the sidecar edit.

## Strip-down step 3 (right-click is the only card menu)
Automated: `npm run test:menu` (selectionMenu: n=1 card, n=1 image, n=3 mixed; edits are one workspace call = one undo step), `npx tsc --noEmit`, `npm run build`.

Manual (`npm run tauri dev`):
1. No ⋯ on any card. The stage dot opens the Stage submenu; Keep/Dismiss, link, `? N` badge still work.
2. Right-click an unselected card: only it is selected and its menu opens. Right-click inside a multi-selection: selection kept. Right-click empty canvas: canvas menu.
3. Menu key / Shift+F10: menu for the selection, else canvas menu at the canvas centre.
4. Select 3 cards: Stage, Add tag, Pin, Bring to front, Duplicate, each undoes with ONE Ctrl+Z. Deepen ▸ Grill me sends one chat turn naming all three.
