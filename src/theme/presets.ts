import type { Theme, ShaderParams } from "./types";

/** D2 approved params; presets override only the palette (and a few knobs). */
const D2_SHADER: Omit<ShaderParams, "palette"> = {
  freq: 1.7,
  fall: 0.5,
  sheen: 0.16,
  sheenPower: 3.5,
  mist: 0.06,
  iridescence: 0.3,
  speed: 0.5,
  scale: 0.16,
};

const STAGES_D2 = { cloud: "#c9d3f5", sketch: "#8fa8f2", draft: "#f0a0c0", pitch: "#ffbf80" };

export const PEARL_GLOW: Theme = {
  id: "pearl-glow",
  name: "Pearl glow",
  builtin: true,
  shader: { ...D2_SHADER, palette: ["#fdebf1", "#f5c3d8", "#fbd3ae", "#ddc9f4", "#ffffff"] },
  ui: {
    ink: "#472a4b",
    body: "#5a3d5e",
    muted: "#6a4a6d",
    link: "#c4699a",
    accent: "#a8447c",
    ghost: "#7b63c9",
    ghostText: "#43308a",
    glass: 0.48,
    fallbackBg: "#fbe3ea",
  },
  stages: STAGES_D2,
};

export const COOL_PEARL: Theme = {
  id: "cool-pearl",
  name: "Cool pearl",
  builtin: true,
  shader: { ...D2_SHADER, palette: ["#e3f1fb", "#a8d5ee", "#f4eeff", "#fff0c6", "#ffffff"] },
  ui: {
    ink: "#1f3550",
    body: "#2f4a66",
    muted: "#3f5b78",
    link: "#4a95c9",
    accent: "#1f6fa8",
    ghost: "#7b63c9",
    ghostText: "#43308a",
    glass: 0.5,
    fallbackBg: "#e3f1fb",
  },
  stages: { cloud: "#bcd6ee", sketch: "#7fb2e0", draft: "#a9a2ea", pitch: "#ffc874" },
};

export const GOLD_SKY: Theme = {
  id: "gold-sky",
  name: "Gold sky",
  builtin: true,
  shader: {
    ...D2_SHADER,
    sheen: 0.14,
    palette: ["#a9c6d9", "#d6e6ea", "#f4ead0", "#e9d29b", "#fff6dc"],
  },
  ui: {
    ink: "#2f2915",
    body: "#473e22",
    muted: "#554a2a",
    link: "#b8902f",
    accent: "#7d5a0e",
    ghost: "#6b63c9",
    ghostText: "#3a3080",
    glass: 0.52,
    fallbackBg: "#d6e6ea",
  },
  stages: { cloud: "#bcd0dc", sketch: "#8fb0c9", draft: "#e2b86a", pitch: "#ffcf6e" },
};

export const IRIDESCENT: Theme = {
  id: "iridescent",
  name: "Iridescent",
  builtin: true,
  shader: {
    ...D2_SHADER,
    iridescence: 0.5,
    palette: ["#ece6fb", "#bde4f4", "#fbd7e7", "#ffe6bf", "#ffffff"],
  },
  ui: {
    ink: "#34285a",
    body: "#463a6e",
    muted: "#554a7c",
    link: "#8a7bd1",
    accent: "#5f40b0",
    ghost: "#7b63c9",
    ghostText: "#43308a",
    glass: 0.5,
    fallbackBg: "#ece6fb",
  },
  stages: { cloud: "#cfd3f5", sketch: "#8fb8ee", draft: "#f0a0c8", pitch: "#ffc080" },
};

export const BUILTIN_THEMES: Theme[] = [PEARL_GLOW, COOL_PEARL, GOLD_SKY, IRIDESCENT];
export const DEFAULT_THEME_ID = PEARL_GLOW.id;
