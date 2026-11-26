import type { ReactNode } from "react";

const base = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
const I = (d: ReactNode) => () => <svg {...base}>{d}</svg>;

export const IconCard = I(<><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M12 9v6M9 12h6" /></>);
export const IconLink = I(<><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></>);
export const IconImage = I(<><rect x="4" y="5" width="16" height="14" rx="3" /><circle cx="9" cy="10" r="1.5" /><path d="m5 17 5-5 4 4 2-2 3 3" /></>);
export const IconClip = I(<><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" /></>);
export const IconSparkle = I(<><path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9Z" /><path d="M19 3v3M17.5 4.5h3" /></>);
export const IconMerge = I(<><path d="M6 4v4a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4v4" /><path d="M18 4v4a4 4 0 0 1-4 4" /><path d="m15 17 3 3 3-3" /></>);
export const IconSend =I(<path d="M5 12 19 5l-4 14-3-6-7-1Z" />);
export const IconPlus = I(<path d="M12 5v14M5 12h14" />);
export const IconMinus = I(<path d="M5 12h14" />);
export const IconFit = I(<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />);
export const IconFolder = I(<path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />);
export const IconClose = I(<path d="M6 6l12 12M18 6 6 18" />);
export const IconTrash = I(<><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7" /><path d="M10 11v6M14 11v6" /></>);
/** Undo / Redo: the usual curved arrows (hook back to the left / forward to the right). */
export const IconUndo = I(<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>);
export const IconRedo = I(<><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>);
export const IconFork = I(<><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 8.5V18M8.3 7A8 8 0 0 1 15.7 11" /></>);
export const IconPin = I(<><path d="M9 4h6l-1 5 3 3v1H7v-1l3-3Z" /><path d="M12 13v7" /></>);
export const IconPower = I(<><path d="M12 4v8" /><path d="M7.5 6.8a7 7 0 1 0 9 0" /></>);
/** Frame: a dashed rectangle with a title tab. */
export const IconFrame = I(<><path d="M4 8V6a2 2 0 0 1 2-2h4" /><rect x="4" y="8" width="16" height="12" rx="2" strokeDasharray="3 2.5" /></>);
/** Design docs: a page with lines and a folded corner. */
export const IconDoc = I(<><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5M9 13h7M9 17h5" /></>);
export const IconCheck = I(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconChecklist = I(<><path d="m4 7 1.5 1.5L8 6M4 13l1.5 1.5L8 12" /><path d="M11 7h9M11 13h9M11 19h9" /><circle cx="6" cy="19" r="1.2" /></>);
/** Think: a light bulb. */
export const IconBulb = I(<><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.6 10.8c.8.6 1.1 1.4 1.1 2.2h5c0-.8.3-1.6 1.1-2.2A6 6 0 0 0 12 3Z" /></>);
