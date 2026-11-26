export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Blend `fg` over `bg` with alpha. */
export function over(fg: RGB, bg: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as RGB;
}

function rgbToHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/**
 * A stage's card border colour: the theme's stage colour, deepened toward `ink` in 5% steps only
 * as far as needed to reach `min` contrast against the card surface it borders (WCAG 1.4.11 asks
 * 3:1 for UI component boundaries). Pale stage colours (Mist) get the most ink; strong ones stay
 * as they are.
 */
export function stageBorder(stageHex: string, inkHex: string, surface: RGB, min = 3): string {
  const stage = hexToRgb(stageHex);
  const ink = hexToRgb(inkHex);
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = over(ink, stage, t);
    if (contrast(c, surface) >= min) return rgbToHex(c);
  }
  return inkHex;
}
