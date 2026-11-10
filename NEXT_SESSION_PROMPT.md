# Dreamer: build prompt for the next session

Paste everything below the line into a fresh Claude Code session opened in `D:\Projects\Dreamer`.

---

You are building **Dreamer**, a desktop app for collecting, linking and deepening game ideas (first use case: a chaotic-but-chill "fish-punk" fishing game, Doom/Ultrakill energy but calmer). Build it end to end in this session, in the order given under "Build order". Make decisions yourself when something is not specified, and note them in `docs/decisions.md`. Do not ask me questions unless something blocks you.

## 1. Stack (decided)

- **Tauri 2** desktop app, **Windows** first. Rust core + web UI.
- **UI:** TypeScript + a light framework (React or Svelte, your pick, justify in one line). Vite.
- **Rust core** owns: file storage, the global hotkey, the Claude sidecar, trash/branch logic.
- **Claude integration:** the **Claude Agent SDK / Claude Code** that is already installed and logged in on this machine. Run it as a Tauri **sidecar** (Node process) that the Rust core spawns and talks to over stdio JSON lines. The user does NOT use an API key. The chat UI is ours, there is no terminal in the UI.
- **Data:** plain files in a workspace folder (see section 4). No database. Claude must be able to read and edit the files natively.

## 2. Visual direction (decided: "D2 Pearl glow, animated")

Reference sketches (12 screens + style variants): https://claude.ai/artifact/HQ4p34J9rbhkgpNzzLzgQZ (screens 1-3 and style D2 are the target; ignore the other variants except as theme presets, see section 6).

**Layout of the main screen (1440x900 reference):**
- Left sidebar (224px, frosted glass): wordmark "Dreamer" (italic serif), Projects list (Inbox with count badge, then projects), "New project" dashed button at the bottom.
- Center: infinite canvas (pan/zoom) on top of the animated shader background, with a faint **dotted grid** (30px, white dots) over the canvas area. Floating pill with project title and stage filter (Cloud / Sketch / Draft / Pitch), bottom-left zoom pill, bottom-center toolbar (add card, link, image, web clip).
- Right: Claude chat panel (340px, frosted glass): header with glowing orb avatar, messages, quick chips (`/grill-me`, Suggest links, Summarize), input with send button.
- Frosted-glass panels: `rgba(255,255,255,.45-.5)`, 1px white border, `backdrop-filter: blur(18px)`, radius 26px.

**Cards** (links are plain lines with an optional label):
- Maturity stage changes the look: **Cloud** (translucent, dashed border, blur) -> **Sketch** (light, thin solid border) -> **Draft** (lifted, shadow) -> **Pitch** (crisp, soft peach glow).
- Stage dot colors: Cloud `#c9d3f5` (dashed ring), Sketch `#8fa8f2`, Draft `#f0a0c0`, Pitch `#ffbf80`.
- Card fields: title, markdown body, images, links/web clips, tags + custom fields.
- **Claude's additions appear as "ghost cards"** (dashed, soft glow, label "Claude suggests", Keep / Dismiss buttons) until the user accepts them.

**D2 default theme tokens:** ink `#472a4b`, body text `#5a3d5e`, muted `#6a4a6d`, link line `#c4699a`, accent `#a8447c`, ghost accent `#7b63c9` (text `#43308a`), fallback background `#fbe3ea`. Fonts: **Playfair Display** (titles) + **Nunito** (UI), via bundled font files (no CDN dependency at runtime). Min touch target 44px, text contrast >= 4.5:1.

**Animated background (WebGL fragment shader, full-screen canvas behind the UI).** Render at ~16% of window size and let the browser upscale it (that is what gives the soft, blurry look). Slow: time multiplier 0.5. Respect `prefers-reduced-motion` (render one still frame). If WebGL fails, fall back to the flat fallback color. Pause when the window is hidden. This is the exact shader and params that were approved:

```glsl
precision highp float;
uniform vec2 R; uniform float T, FALL;
uniform vec3 C0,C1,C2,C3,C4; uniform float IRI,FREQ,SH,MIST,SHP;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.02+vec2(1.7,9.2);a*=FALL;}return v;}
vec2 UV(){return vec2(gl_FragCoord.x/R.x,1.-gl_FragCoord.y/R.y);}
void main(){
  vec2 uv=UV(); vec2 p=(uv-.5)*vec2(R.x/R.y,1.)*FREQ; float t=T*.07;
  p+=.16*vec2(sin(p.y*2.3+T*.32),cos(p.x*2.1+T*.28));
  vec2 q=vec2(fbm(p+t),fbm(p+vec2(5.2,1.3)-t));
  vec2 r=vec2(fbm(p+2.4*q+vec2(1.7,9.2)+t*1.3),fbm(p+2.4*q+vec2(8.3,2.8)-t));
  float f=fbm(p+2.4*r);
  vec3 col=mix(C0,C1,smoothstep(.15,.85,f));
  col=mix(col,C2,smoothstep(.35,.9,length(q))*.7);
  col=mix(col,C3,smoothstep(.45,.95,r.x)*.6);
  float sheen=pow(abs(sin(f*10.+r.y*6.+T*.22)),SHP);
  col+=C4*sheen*SH;
  col+=IRI*.05*vec3(sin(f*7.),sin(f*7.+2.1),sin(f*7.+4.2));
  col=mix(col,vec3(1.),.1*smoothstep(.3,1.1,length(uv-.5)));
  col=mix(col,vec3(1.),MIST);
  gl_FragColor=vec4(clamp(col,0.,1.),1.);
}
```

D2 params: `FREQ=1.7, FALL=0.5, SH=0.16, SHP=3.5, MIST=0.06, IRI=0.3`, time = `seconds * 0.5 + 33`, palette `C0..C4 = #fdebf1, #f5c3d8, #fbd3ae, #ddc9f4, #ffffff`. Keep the 5-color palette + these params as the **theme's shader block** (section 6).

## 3. Product decisions (all decided)

1. **Projects:** each project is its own infinite canvas. A special **Inbox** canvas collects raw ideas.
2. **Quick capture:** a **global hotkey** (default `Ctrl+Shift+Space`, configurable) opens a small always-on-top popup ("Catch a thought"). Enter drops the text into the Inbox as a **Cloud** card. Esc closes. Works while the app is minimized/in tray.
3. **Cards:** rich text/markdown, images, links and web clips, tags and custom fields. Links are plain lines with an optional label. Maturity stages: **Cloud -> Sketch -> Draft -> Pitch**.
4. **Pitch output:** when a card is at Pitch, an **Export design brief** action has Claude compile the card, its linked cards and its grill-me notes into a one-page markdown brief (saved in the project's `briefs/`). The button is disabled with the hint "Unlocks when the card reaches Pitch" before then.
5. **Claude panel:** chat that can **create, link, edit and re-stage cards directly** on the canvas, plus **`/grill-me` mode**: Claude interviews the user about the selected card with multiple-choice questions (2-4 options + free text) and writes the answers back into the card as notes. Claude's new cards are **ghost cards** until accepted. Claude never deletes anything itself (it can only propose; deletion goes through the Trash).
6. **Themes** (section 6). 7. **Branching, compare, trash** (section 7).

## 4. Data layout (plain files, git-friendly)

```
<workspace>/                      # default: %USERPROFILE%\Dreamer, user-changeable
  workspace.json                  # app settings: global theme id, hotkey, last project
  themes/<id>.json                # user themes (built-ins ship in the app)
  projects/<project-slug>/
    project.json                  # name, theme override (optional), created
    canvas.json                   # card positions, links, viewport
    cards/<card-id>.md            # frontmatter + markdown body
    cards/<card-id>.variants/     # branch variants of a card (section 7)
    media/                        # pasted/dropped images
    briefs/                       # exported design briefs
    trash/                        # trashed cards (+ trash.json index)
  inbox/                          # same shape as a project, slug "inbox"
```

Card file frontmatter: `id, title, stage, tags[], fields{}, created, updated, source ("user"|"claude"), ghost (bool), links[] {to, label?}, branch? {...}`. Use stable ids (ULID). Write atomically (temp file + rename). Watch the folder so external edits (Claude Code, git) show up live.

## 5. Claude sidecar

- Node sidecar using the Claude Agent SDK, spawned by Rust, working directory = the active project folder. Streams assistant text and tool events to the UI.
- Expose **app tools** to Claude (MCP-style, in-process): `list_cards`, `read_card`, `create_card` (always `ghost:true`), `update_card`, `set_stage`, `link_cards`, `suggest_variants(card_id, n)` (creates ghost variants), `export_brief(card_id)`, and for grill-me: `ask_user(question, options[])` which renders the multiple-choice card in the chat and returns the answer. No delete tool.
- Give Claude the active card/selection as context on each message. System prompt: concise, warm, game-design-savvy; in grill-me mode ask ONE question at a time, write each answer to the card's notes immediately.
- Handle "Claude Code not found / not logged in" with a friendly setup screen.

## 6. Themes (decided)

- A **theme** re-tints everything: the shader block (5-color palette + params above), UI tokens (ink, body, muted, link, accent, ghost accent, card tints, glass alpha), stage dot colors, and a fallback background.
- **Built-in presets** (ship at least these, each with tuned shader palette + UI tokens that keep text contrast >= 4.5:1): **Pearl glow** (default, = D2), **Cool pearl** (A2 palette `#e3f1fb,#a8d5ee,#f4eeff,#fff0c6,#ffffff`), **Gold sky** (C2 palette `#a9c6d9,#d6e6ea,#f4ead0,#e9d29b,#fff6dc`), **Iridescent** (A3 palette `#ece6fb,#bde4f4,#fbd7e7,#ffe6bf,#ffffff`). Optionally an aura-style preset if time allows.
- **Custom theme editor:** pick the 5 shader colors + UI accent colors with live preview, tweak speed/blur/sheen sliders, save as a named theme (`themes/<id>.json`), duplicate, delete. Validate contrast and warn (do not block).
- **Scope:** one **global** theme (in `workspace.json`) with an **optional per-project override** (`project.json`). Switching is instant with a short cross-fade.
- Theme JSON schema: `{ id, name, shader: { palette[5], freq, fall, sheen, sheenPower, mist, iridescence, speed, scale }, ui: { ink, body, muted, link, accent, ghost, ghostText, glass, fallbackBg }, stages: { cloud, sketch, draft, pitch } }`.

## 7. Branching, compare, trash (decided)

- **What can branch:** a **single card**. "Branch" turns a card into a **fork** with 2+ variants (the original becomes variant 1). Variants inherit the card's links, stage and tags; each has its own title/body/notes. Stored in `cards/<id>.variants/<variant-id>.md`.
- **Making variants:** manually (Branch -> editable copy) **and** via Claude ("Give me 3 takes" -> `suggest_variants` creates ghost variants the user can edit/accept).
- **Canvas display:** a forked card shows as a **stacked card with a badge** ("3 variants"). Click it to open the **compare view**.
- **Compare view:** 2-4 variants side by side in columns, with a **diff highlight** of what differs between them. In compare view the user can edit a variant, add one, or **Pick this one**.
- **Pick a winner:** the picked variant becomes the card (keeps position, links, stage). All others go to the project's **Trash**, labeled **"lost to <winner title>"**. The fork badge disappears.
- **Trash:** per project, shown as a sidebar entry. It catches **rejected variants and ordinary deletions** (every deleted card), each item labeled **why** it is there ("lost to ..." or "deleted"). Everything is restorable. Nothing auto-deletes; the user empties it manually (with a confirmation).
- **Restore:** when restoring a rejected variant, **ask each time**: (a) as a new standalone card next to the winner, linked by a "was alternative to" line, or (b) back into the fork as a variant. Ordinary deleted cards restore to their old position.
- All of this must work with Undo (Ctrl+Z) for the last few actions.

## 8. Build order (do all of it; commit after each step)

1. **Scaffold** Tauri 2 + Vite + TS in `D:\Projects\Dreamer`. `git init`, `.gitignore`, README, `docs/decisions.md`. Verify `cargo tauri dev` opens a window.
2. **Shell + theme system:** sidebar/canvas/chat layout, the WebGL background with D2 params, theme tokens as CSS variables, theme switcher with the 4 presets, glass panels.
3. **Storage core (Rust):** workspace, projects, Inbox, card CRUD, canvas.json, file watcher, atomic writes. Commands exposed to the UI.
4. **Canvas:** infinite pan/zoom, dotted grid, drag cards, add/edit cards, links with optional labels, stage look per card, stage filter, images and web-clip cards.
5. **Quick capture:** global hotkey popup -> Inbox Cloud card; tray behavior.
6. **Claude sidecar + chat panel:** streaming chat, app tools, ghost cards (Keep/Dismiss), `/grill-me` mode with multiple-choice questions, setup screen if Claude Code is missing.
7. **Branch / compare / trash:** fork badge, compare view with diff, pick winner -> trash, Trash view with labels and restore choice, "Give me 3 takes".
8. **Theme editor** (custom palettes, per-project override) and **Export design brief** for Pitch cards.
9. **Polish:** keyboard shortcuts, Undo, empty states, reduced motion, error handling, performance (60fps canvas with ~500 cards).

## 9. Definition of done

- `cargo tauri dev` runs; `cargo tauri build` produces a Windows installer.
- I can: create a project, drop cards, link them, move them through stages, capture an idea with the hotkey into the Inbox, chat with Claude (it creates ghost cards I can accept), run `/grill-me` on a card, branch a card, compare variants, pick one (others land in Trash labeled), restore one with a choice, switch themes (including a custom one and a per-project override), and export a design brief from a Pitch card.
- The look matches the D2 sketch: animated pearl-pink shader, dotted grid, frosted glass panels, soft serif titles.
- Short test plan in `docs/testing.md` and a note on anything you could not verify.

Start with step 1 now. After each step, tell me in two lines what works and what is next.
