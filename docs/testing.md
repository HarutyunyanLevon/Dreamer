# Testing

## Step 1 smoke test (manual, Windows)
1. `npm install`
2. `npm run tauri dev` : a 1440x900 window titled "Dreamer" shows the italic wordmark on a pink background.
3. `npm run tauri build` : NSIS and MSI installers appear in `src-tauri/target/release/bundle/`.

## Not verified by the author
- Anything that runs on Windows (`tauri dev`, `tauri build`, the global hotkey, tray). Rust compiles on Linux (`cargo check`); UI type-checks and bundles (`npm run build`).
