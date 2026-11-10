# Dreamer

A desktop app for collecting, linking and deepening game ideas. Each project is an infinite canvas of idea cards (Cloud, Sketch, Draft, Pitch), with a Claude chat panel that can add ghost cards, grill you about a card and compile a design brief.

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

## Build installer
```
npm run tauri build
```
Installers land in `src-tauri/target/release/bundle/`.

See `docs/decisions.md` for design decisions and `docs/testing.md` for the test plan.
# Dreamer
