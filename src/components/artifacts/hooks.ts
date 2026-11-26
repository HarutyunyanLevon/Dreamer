import { useEffect, useState } from "react";
import { api, type ArtifactFile, type ArtifactVersion, type ArtifactView } from "../../api";
import { useArtifactStamp } from "../../state/artifactRuns";

/** artifact_get for one artifact, reloaded whenever its files change (or `bump` changes). */
export function useArtifact(slug: string | null, id: string, bump?: unknown) {
  const stamp = useArtifactStamp(id);
  const [view, setView] = useState<ArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!slug) return;
    let live = true;
    api
      .artifactGet(slug, id)
      .then((v) => {
        if (!live) return;
        setView(v);
        setError(null);
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [slug, id, stamp, bump]);
  return { view, setView, error, stamp };
}

const urlCache = new Map<string, string>();

/** A version file as a data: URL (cached per artifact/version/file/stamp). */
export function useArtifactFileUrl(slug: string | null, id: string, version: number | undefined, file: string | undefined, stamp: string) {
  const key = slug && version && file ? `${slug}/${id}/v${version}/${file}@${stamp}` : null;
  const [url, setUrl] = useState<string | null>(key ? urlCache.get(key) ?? null : null);
  useEffect(() => {
    if (!key || !slug || !version || !file) {
      setUrl(null);
      return;
    }
    const hit = urlCache.get(key);
    if (hit) {
      setUrl(hit);
      return;
    }
    let live = true;
    api
      .artifactFile(slug, id, version, file)
      .then((u) => {
        if (urlCache.size > 200) urlCache.clear();
        urlCache.set(key, u);
        if (live) setUrl(u);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [key, slug, id, version, file]);
  return url;
}

const isImageFile = (f: string) => /\.(png|webp|gif|jpe?g|svg)$/i.test(f);
export const isVideoFile = (f: string) => /\.(mp4|webm)$/i.test(f);
export const isHtmlFile = (f: string) => /\.html$/i.test(f);

/** The visual files of a version, hero first (then key art, concept, turnaround...). */
export function visualFiles(v: ArtifactVersion | undefined): ArtifactFile[] {
  if (!v) return [];
  const rank = (f: ArtifactFile) => {
    const r = f.role ?? "";
    if (r === "hero" || /^hero\./.test(f.file)) return 0;
    if (r === "key-art" || /^key-art\./.test(f.file)) return 1;
    if (r === "concept" || /^concept/.test(f.file)) return 2;
    if (f.file.startsWith("assets/")) return 9;
    return 5;
  };
  return v.files.filter((f) => isImageFile(f.file) || isVideoFile(f.file)).sort((a, b) => rank(a) - rank(b));
}

/** The file the card shows: an HTML page for mockups and themes when there is one, else the first visual. */
export function coverOf(view: ArtifactView, v: ArtifactVersion | undefined): { kind: "html" | "image" | "video"; file: string } | null {
  if (!v) return null;
  const html = v.files.find((f) => f.file === "index.html") ?? v.files.find((f) => isHtmlFile(f.file));
  if (html && view.type === "mockup") return { kind: "html", file: html.file };
  const vis = visualFiles(v).filter((f) => !f.file.startsWith("assets/"));
  if (vis.length) return { kind: isVideoFile(vis[0].file) ? "video" : "image", file: vis[0].file };
  if (html) return { kind: "html", file: html.file };
  return null;
}
