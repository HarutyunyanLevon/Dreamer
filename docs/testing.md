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

## Not verified by the author
- The real Tauri command round trip and file watcher on Windows (only Rust unit tests on Linux and the mock-backed UI in a browser were run), e.g. `fs::rename` over a file another program has open (antivirus, editor) could fail on Windows and would surface as an error toast.
- Anything that runs on Windows beyond step 1 (the reduced-motion OS toggle, window minimize/restore, real GPU rendering, the global hotkey, tray, `tauri build`). On my side the UI type-checks and bundles, and screenshots were taken in headless Chrome with software WebGL (all 4 themes), not in the Tauri WebView2 window.
