import type { ReactNode } from "react";

const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const I = (d: ReactNode) => () => <svg {...base}>{d}</svg>;

export const IconCard = I(<><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M12 9v6M9 12h6" /></>);
export const IconLink = I(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>);
export const IconImage = I(<><rect x="4" y="5" width="16" height="14" rx="3" /><circle cx="9" cy="10" r="1.5" /><path d="m5 17 5-5 4 4 2-2 3 3" /></>);
export const IconClip = I(<><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" /></>);
export const IconSend = I(<path d="M5 12 19 5l-4 14-3-6-7-1Z" />);
export const IconPlus = I(<path d="M12 5v14M5 12h14" />);
export const IconMinus = I(<path d="M5 12h14" />);
export const IconFit = I(<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />);
export const IconInbox = I(<><path d="M4 13h4l1.5 3h5L16 13h4" /><path d="M5.5 6h13L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5Z" /></>);
export const IconFolder = I(<path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />);
export const IconClose = I(<path d="M6 6l12 12M18 6 6 18" />);
export const IconTrash = I(<><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" /><path d="M10 11v6M14 11v6" /></>);
export const IconUndo = I(<path d="M7 7v6h6M7 13a7 7 0 1 1 2 5" />);
export const IconRedo = I(<path d="M17 7v6h-6M17 13a7 7 0 1 1-2 5" />);
