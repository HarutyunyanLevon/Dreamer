import type { ArtifactType } from "../../api";

/** Small line icons for the four artifact types (currentColor, 16px). */
export function ArtifactIcon({ type, size = 16 }: { type: ArtifactType; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (type) {
    case "theme":
      // A palette.
      return (
        <svg {...common}>
          <path d="M8 2.2a5.8 5.8 0 1 0 0 11.6c.9 0 1.3-.6 1.3-1.2 0-.8-.7-1-.7-1.8 0-.7.6-1.2 1.4-1.2h1.6a2.6 2.6 0 0 0 2.6-2.6C14.2 4.5 11.4 2.2 8 2.2Z" />
          <circle cx="5.2" cy="7" r=".8" fill="currentColor" />
          <circle cx="7.6" cy="4.9" r=".8" fill="currentColor" />
          <circle cx="10.4" cy="5.6" r=".8" fill="currentColor" />
        </svg>
      );
    case "character":
      return (
        <svg {...common}>
          <circle cx="8" cy="5" r="2.6" />
          <path d="M3 14c.5-3 2.6-4.6 5-4.6s4.5 1.6 5 4.6" />
        </svg>
      );
    case "mockup":
      return (
        <svg {...common}>
          <rect x="2" y="2.8" width="12" height="10.4" rx="1.6" />
          <path d="M2 5.6h12M4.6 8.4h3.4M4.6 10.6h6" />
        </svg>
      );
    default:
      // Concept art: a framed landscape.
      return (
        <svg {...common}>
          <rect x="2" y="2.8" width="12" height="10.4" rx="1.6" />
          <path d="m2.6 11.6 3.4-3.4 2.4 2.4 1.8-1.8 3.2 3.2" />
          <circle cx="10.6" cy="5.8" r="1" />
        </svg>
      );
  }
}
