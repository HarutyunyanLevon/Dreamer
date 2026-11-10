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

## Not verified by the author
- Window minimize/restore, real GPU rendering nuances, and `tauri build`'s installers (not run this session; see step 9).
- The reduced-motion OS toggle (Windows Settings > Accessibility).
