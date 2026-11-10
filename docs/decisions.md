# Decisions

Newest at the bottom. Each entry: what, why.

## Step 1: Scaffold
- **UI framework: React 19.** Biggest ecosystem for canvas, markdown and drag tooling, and the most predictable to write without a live preview loop; performance for ~500 cards is handled with memoised card components and CSS transforms.
- **Package manager: npm.** Ships with Node, no extra install on the user's machine.
- **Bundle targets: NSIS + MSI only** (Windows first), instead of "all", so `tauri build` does not try other platforms.
- **Window: 1440x900 default, min 960x600**, matching the reference layout.
- **Removed `tauri-plugin-opener`** from the template; re-add it in the web-clip step if needed.
- **Build environment note:** steps were authored in a Linux workspace without a shell on the Windows machine. Rust was verified with `cargo check` and the UI with `vite build` there; `cargo tauri dev` / `build` on Windows are unverified by me (see docs/testing.md).
