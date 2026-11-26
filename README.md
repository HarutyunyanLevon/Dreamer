# Dreamer

A pretty place to think with Claude about game ideas: an infinite canvas of cards. Claude helps you deepen an idea (grill, expand, critique), broaden it (other takes, what-ifs, related) and find inspiration (web references, visualize). When an idea is ready, Dreamer writes a design-doc pack into a repo and Claude Code takes it from there, outside Dreamer. See `docs/identity.md` for what Dreamer is and is not.

## Features
- One infinite canvas per project: cards (Mist, Reverie, Lucid, Dream, Built), checklists, images, web clips, artifacts (themes, characters, concept art, mockups), frames, links, branches, trash.
- Claude chat per card and per project: /grill-me, /expand, /critique, /related, /organize, ghost cards and edit proposals you keep or dismiss, web access, per-project memory.
- Handoff pack: Summarize writes design docs, a roadmap and a CLAUDE.md block into the linked repo folder, replacing the last pack.
- `.dreamer.md` bundles: paste or drop them to add cards.
- Presets: four themes with a shader background, per project override.

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
npx tsc --noEmit
npm run check:themes
npm run test:reliability
npm run test:checklist
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
