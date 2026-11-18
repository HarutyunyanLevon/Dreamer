import { useEffect, useState } from "react";
import { api } from "../../api";
import playfair500 from "@fontsource/playfair-display/files/playfair-display-latin-500-normal.woff2?url";
import playfair600 from "@fontsource/playfair-display/files/playfair-display-latin-600-normal.woff2?url";
import nunito400 from "@fontsource/nunito/files/nunito-latin-400-normal.woff2?url";
import nunito700 from "@fontsource/nunito/files/nunito-latin-700-normal.woff2?url";

/** The two bundled families a theme may use, as data: @font-face rules (the sandbox loads nothing else). */
let fontCss: Promise<string> | null = null;
function bundledFonts(): Promise<string> {
  if (fontCss) return fontCss;
  const faces: [string, string, number][] = [
    ["Playfair Display", playfair500, 500],
    ["Playfair Display", playfair600, 600],
    ["Nunito", nunito400, 400],
    ["Nunito", nunito700, 700],
  ];
  fontCss = Promise.all(
    faces.map(async ([family, url, weight]) => {
      const buf = await (await fetch(url)).arrayBuffer();
      let bin = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:swap;src:url(data:font/woff2;base64,${btoa(bin)}) format("woff2");}`;
    }),
  )
    .then((rules) => `<style>${rules.join("")}</style>`)
    .catch(() => "");
  return fontCss;
}

/**
 * An HTML artifact (mockup or theme style guide) running live in a sandbox: scripts allowed, but
 * no same-origin access (it can't reach the app), and the bundled page carries a CSP that blocks
 * every network request; its files are inlined as data: URLs by the core.
 */
export function ArtifactFrame({ slug, id, version, title, className, interactive = true, stamp }: { slug: string; id: string; version: number; title: string; className?: string; interactive?: boolean; stamp?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    bundledFonts()
      .then((head) => api.artifactHtml(slug, id, version, head))
      .then((h) => live && setHtml(h))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [slug, id, version, stamp]);
  if (error) return <div className={`artifact-empty ${className ?? ""}`}>No page in v{version} yet</div>;
  if (html === null) return <div className={`artifact-loading ${className ?? ""}`} />;
  return (
    <iframe
      className={`artifact-frame ${className ?? ""}`}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={html}
      tabIndex={interactive ? 0 : -1}
      style={interactive ? undefined : { pointerEvents: "none" }}
    />
  );
}
