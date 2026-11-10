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
3. Click stage filters (Cloud/Sketch/Draft/Pitch): matching demo cards hide and show.
4. Windows Settings > Accessibility > Visual effects > Animation effects off: the background becomes a still image (restart the app to be sure).
5. Minimize the window for a minute and restore: animation resumes without a time jump.
6. Resize to the minimum (1100x600): nothing overlaps.

## Step 3 checks
Automated (any OS): `cd src-tauri && cargo test` runs 17 tests: workspace layout, settings + corrupt-file backup, project slugs (Inbox reserved), path-traversal rejection, card file round trip (CRLF/BOM/unknown keys/`---` inside body), reconcile of externally added/removed cards, delete/restore/empty trash, atomic write, viewport save, watcher path classification, a real file-watcher event, and the JSON contract with the UI.

Manual (Windows, `npm run tauri dev`; workspace appears at `%USERPROFILE%\Dreamer`):
1. First launch creates `Dreamer\workspace.json`, `Dreamer\inbox\...` and `Dreamer\themes\`. The sidebar shows Inbox (no badge while empty) and an empty-state message on the canvas.
2. Click **Card** (toolbar): a "New idea" Cloud card appears; a file `inbox\cards\<ULID>.md` exists and `inbox\canvas.json` has its position. The Inbox badge shows 1.
3. **New project** > type a name > Enter: it appears in the sidebar and is selected; `projects\<slug>\` has `cards`, `media`, `briefs`, `trash`, `project.json`, `canvas.json`.
4. Live reload: copy a card file within `cards\` (new name) or create `cards\01TEST.md` with `---`, `title: From outside`, `stage: sketch`, `---`, a body line. It appears on the canvas within about a second, no restart.
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

Not verified live: opening the Theme editor and dragging its sliders/color pickers, opening the per-project theme picker popover in the title pill, and clicking "Export brief" on a Pitch card inside the actual window. Same native-window GUI-automation gap as steps 4-6 — each of these is built on `saveCustomTheme`/`deleteCustomTheme`/`setProjectTheme`/`exportBrief`, which call straight through to the Rust functions covered by the new unit tests above.

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
