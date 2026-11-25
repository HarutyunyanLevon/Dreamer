/** Scrollbar thumb = ink at this alpha (checked for 3:1 against glass in check:themes). */
export const SCROLL_THUMB_ALPHA = 0.58;
export const SCROLL_THUMB_HOVER_ALPHA = 0.75;
export const SCROLL_TRACK_ALPHA = 0.07;

export type StageId = "mist" | "reverie" | "lucid" | "dream" | "built";
/** Themes saved before the Built stage have no colour for it. */
export const BUILT_COLOR = "#7fcfae";
/** White alpha of each stage's card background (mirrors .stage-* in styles.css). Fuzzy to crisp. */
export const STAGE_CARD_ALPHA: Record<StageId, number> = { mist: 0.3, reverie: 0.9, lucid: 0.84, dream: 0.96, built: 0.96 };
export const STAGES: StageId[] = ["mist", "reverie", "lucid", "dream", "built"];
export const STAGE_LABEL: Record<StageId, string> = {
  mist: "Mist",
  reverie: "Reverie",
  lucid: "Lucid",
  dream: "Dream",
  built: "Built",
};

export interface ShaderParams {
  /** C0..C4 as #rrggbb */
  palette: [string, string, string, string, string];
  freq: number;
  fall: number;
  sheen: number;
  sheenPower: number;
  mist: number;
  iridescence: number;
  /** time multiplier */
  speed: number;
  /** render size as a fraction of the window (0.16 = soft blur look) */
  scale: number;
}

export interface UiTokens {
  ink: string;
  body: string;
  muted: string;
  link: string;
  accent: string;
  ghost: string;
  ghostText: string;
  /** frosted glass alpha, 0..1 */
  glass: number;
  fallbackBg: string;
}

export interface Theme {
  id: string;
  name: string;
  builtin?: boolean;
  shader: ShaderParams;
  ui: UiTokens;
  stages: Partial<Record<StageId, string>> & Record<Exclude<StageId, "built">, string>;
}
