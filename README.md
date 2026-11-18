# Dreamer

A desktop app for collecting, linking and deepening game ideas. Each project is an infinite canvas of idea cards (Mist, Reverie, Lucid, Dream), with a Claude chat panel that can add ghost cards, grill you about a card and compile a design brief.

First use case: a chaotic-but-chill "fish-punk" fishing game.

## Stack
Tauri 2 (Rust core) + React + TypeScript + Vite. Data is plain files in a workspace folder (no database). Claude runs through the locally installed Claude Code / Agent SDK as a sidecar (no API key).

## Requirements (Windows)
- Node 20+ and npm
- Rust (stable) with the MSVC toolchain
- Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11)

## Run
```
npm install
npm run tauri dev
```

## Test
```
cd src-tauri && cargo test
npm run check:themes
```

## Build installer
```
npm run release
```
Builds the sidecar (`src-tauri/sidecar-dist`), the frontend and the NSIS installer, and prints its path: `src-tauri/target/release/bundle/nsis/Dreamer_<version>_x64-setup.exe`. App icons come from `src-tauri/icons/source.svg` (`npm run icons` re-renders them).

## Install / update
- Run `Dreamer_<version>_x64-setup.exe`. It installs for the current user (no admin) into `%LOCALAPPDATA%\Dreamer` and adds a Start menu shortcut.
- Needs Node.js and Claude Code on the machine; if either is missing, Dreamer's setup screen walks you through it.
- To update, run the newer installer over the old one. It closes a running Dreamer first.
- Your ideas live in the workspace (`%USERPROFILE%\Dreamer` by default), never in the install folder, so reinstalling, updating or uninstalling keeps them.

See `docs/decisions.md` for design decisions and `docs/testing.md` for the test plan.
