export type StageId = "cloud" | "sketch" | "draft" | "pitch";
export const STAGES: StageId[] = ["cloud", "sketch", "draft", "pitch"];
export const STAGE_LABEL: Record<StageId, string> = {
  cloud: "Cloud",
  sketch: "Sketch",
  draft: "Draft",
  pitch: "Pitch",
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
  stages: Record<StageId, string>;
}
