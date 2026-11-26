import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * Cached, downscaled image URLs for the canvas. Each (project, path, size) is read and decoded once,
 * shrunk to a small WebP data URL on an offscreen canvas, and kept in an LRU, so hundreds of cards
 * never hold full-size images or repeat the IPC read. Decodes run a few at a time to keep frames free.
 */

const MAX_ENTRIES = 600;
const MAX_CONCURRENT = 3;
const cache = new Map<string, Promise<string>>();
let running = 0;
const queue: (() => void)[] = [];

function touch(key: string, p: Promise<string>) {
  cache.delete(key);
  cache.set(key, p);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

function slot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      fn().then(resolve, reject).finally(() => {
        running--;
        queue.shift()?.();
      });
    };
    if (running < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

async function shrink(src: string, maxPx: number): Promise<string> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  await img.decode();
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale >= 1) return src;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return src;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/webp", 0.82);
}

/** A display URL for a media/ file, at most `maxPx` on its long side (0 = full size, not cached long). */
function mediaUrl(slug: string, rel: string, maxPx = 0): Promise<string> {
  const key = `${slug}|${rel}|${maxPx}`;
  const hit = cache.get(key);
  if (hit) {
    touch(key, hit);
    return hit;
  }
  const p = slot(async () => {
    const full = await api.readMedia(slug, rel);
    // SVGs and icons stay as they are (tiny, and canvas can't always rasterize them).
    if (!maxPx || /\.(svg|ico)$/i.test(rel)) return full;
    try {
      return await shrink(full, maxPx * Math.min(2, window.devicePixelRatio || 1));
    } catch {
      return full;
    }
  });
  p.catch(() => cache.delete(key));
  if (maxPx) touch(key, p);
  return p;
}

/** React hook over `mediaUrl`; null until loaded (or when `rel` is missing / `enabled` is false). */
export function useMediaUrl(slug: string | null, rel: string | undefined, maxPx: number, enabled = true): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!slug || !rel || !enabled) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    mediaUrl(slug, rel, maxPx).then((u) => !cancelled && setUrl(u), () => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
    };
  }, [slug, rel, maxPx, enabled]);
  return url;
}

/** First http(s) URL in a pasted/dropped string, if the whole thing is just a link. */
export function asUrl(text: string | undefined | null): string | null {
  const t = (text ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  try {
    return new URL(t).toString();
  } catch {
    return null;
  }
}
