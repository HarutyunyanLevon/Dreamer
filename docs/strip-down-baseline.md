# Strip-down baseline (branch strip-down, v0.5.3)

Every later step must end no worse.

| Check | Result |
|---|---|
| `cargo test` (src-tauri) | 187 passed, 0 failed, 4 ignored |
| `npx tsc --noEmit` | clean |
| `npm run test:reliability` | ok |
| `npm run test:versions` | removed in step 1 (feature gone) |
| `npm run test:checklist` | ok |
| `npm run check:themes` | ok (all themes meet contrast) |

Known failures: none. Not run: `vite build`, `npm run reliability` (live harness).
Note: `test:versions` covers a feature slated for removal; drop it with that feature.

## After step 2
| Check | Result |
|---|---|
| `cargo test` (src-tauri) | 131 passed, 0 failed, 3 ignored (tests of removed features dropped, step f test added) |
| `npx tsc --noEmit` | clean |
| `npm run build` | ok |
| `npm run test:reliability` | ok |
| `npm run test:checklist` | ok |
| `npm run check:themes` | ok |

## After step 5 (refactor, no behavior change)
| Check | Result |
|---|---|
| `cargo test` (src-tauri) | 132 passed, 0 failed, 3 ignored |
| `npx tsc --noEmit` | clean |
| `npm run build` | ok; built CSS bundle byte-identical to before the css split |
| `npm run test:reliability`, `test:checklist`, `test:menu`, `check:themes` | ok |
| `npm run build:sidecar` | packaged sidecar starts, clean exit |

Line counts (ts/tsx/rs/mjs/css, tracked files): 33,357 total, unchanged to within the few import lines each split adds.

| File before | Lines | After | Largest piece |
|---|---|---|---|
| storage.rs | 2025 | storage/{mod,cards,chats,canvas,media,trashbin,tests} | tests 771 |
| sidecar.rs | 1438 | sidecar/{mod,process,events,protocol,tests} | mod 473 |
| claude-sidecar.mjs | 2543 | 17 modules | turn.mjs 450 |
| CanvasArea.tsx + canvasMenus.tsx | 1850 + 438 | canvas/{Canvas,CardView,Links,Overlays,menus/*} | Canvas 1318 |
| ChatPanel.tsx | 1131 | chat/{ChatPanel,MessageView,QuestionForm,Status} | ChatPanel 625 |
| useWorkspace.ts | 1424 | state/workspace/{index,organizeSim} | index 1296 |
| styles.css | 1402 | styles/*.css (9) | menus-frames 572 |

Not done, on purpose: Canvas.tsx and workspace/index.ts stay over 600 (see architecture.md); unused-selector scan found no dead css classes; handoff.rs is already only the pack.
