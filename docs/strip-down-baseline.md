# Strip-down baseline (branch strip-down, v0.5.3)

Every later step must end no worse.

| Check | Result |
|---|---|
| `cargo test` (src-tauri) | 187 passed, 0 failed, 4 ignored |
| `npx tsc --noEmit` | clean |
| `npm run test:reliability` | ok |
| `npm run test:versions` | ok |
| `npm run test:checklist` | ok |
| `npm run check:themes` | ok (all themes meet contrast) |

Known failures: none. Not run: `vite build`, `npm run reliability` (live harness).
Note: `test:versions` covers a feature slated for removal; drop it with that feature.
