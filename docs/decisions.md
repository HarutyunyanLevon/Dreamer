# Decisions

Newest at the bottom. Each entry: what, why.

## Step 1: Scaffold
- **UI framework: React 19.** Biggest ecosystem for canvas, markdown and drag tooling, and the most predictable to write without a live preview loop; performance for ~500 cards is handled with memoised card components and CSS transforms.
- **Package manager: npm.** Ships with Node, no extra install on the user's machine.
- **Bundle targets: NSIS + MSI only** (Windows first), instead of "all", so `tauri build` does not try other platforms.
- **Window: 1440x900 default, min 960x600**, matching the reference layout.
- **Removed `tauri-plugin-opener`** from the template; re-add it in the web-clip step if needed.
- **Build environment note:** steps were authored in a Linux workspace without a shell on the Windows machine. Rust was verified with `cargo check` and the UI with `vite build` there; `cargo tauri dev` / `build` on Windows are unverified by me (see docs/testing.md).

## Step 2: Shell + theme system
- **Layout:** the canvas fills the whole window; the sidebar (224px) and chat (340px) float over it as frosted-glass panels with a 16px margin. The floating pills center themselves in the free column between the panels via CSS. Minimum window width raised to 1100px so the title pill, zoom pill and toolbar never collide.
- **Fonts:** `@fontsource/playfair-display` (500/600, normal + italic) and `@fontsource/nunito` (400/600/700), latin subset only, imported in `main.tsx`. Vite bundles the woff2 files into the app: no CDN at runtime.
- **Shader:** the approved GLSL is used verbatim (`src/theme/shader.ts`). Time = `33 + accumulated(dt * speed)` so changing speed never makes the animation jump. Renders at `scale` (0.16) of the window and the browser upscales it. Pauses when the document is hidden, renders a single still frame under `prefers-reduced-motion`, and falls back to the flat theme color (body background) if WebGL or the shader fails or the context is lost.
- **Theme switch cross-fade:** shader palette and params are interpolated over 600ms in JS; UI colors transition via CSS (0.5s). The saved theme is applied before first render (`bootTheme`) so there is no flash of the default colors.
- **Theme data:** types match the schema in the brief. `ui.glass` is a number (alpha 0..1). Stage dot colors are theme-specific; derived values (glows, soft tints) are computed in `applyTheme`.
- **Non-Pearl presets:** shader palettes are exactly as specified; UI tokens were tuned by me to keep text contrast >= 4.5:1. `npm run check:themes` prints every checked pair. Gold sky uses slightly lower sheen (0.14) and Iridescent higher iridescence (0.5).
- **Contrast checks** (`src/theme/contrast.ts`) test text against the worst-case surface: the theme's fallback color under the glass alpha, and a 30% white "cloud card".
- **Persistence for now:** selected theme id in `localStorage`. Replaced by `workspace.json` in step 3.
- **Demo cards and disabled chat controls** on the canvas/chat are placeholders to judge the look; real cards arrive in step 4 and chat in step 6.
- **Sidebar Theme switcher** is a row of four 44px swatches above "New project".
