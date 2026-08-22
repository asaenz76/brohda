import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ShareImageFont {
  name: string;
  data: Buffer;
  weight: 400 | 600 | 700;
  style: "normal";
}

// satori (the renderer behind next/og's ImageResponse) needs real font
// binary data — it has no system-font fallback the way a browser does —
// but the app only ever loads Inter through next/font/google, which never
// exposes a readable file path. Vendored once into public/fonts/ (woff,
// not woff2 — satori doesn't support woff2) rather than fetched from
// Google Fonts at request time, so a share-image download never depends on
// an external font CDN being up.
let cached: ShareImageFont[] | null = null;

export async function loadShareImageFonts(): Promise<ShareImageFont[]> {
  if (cached) return cached;

  const dir = path.join(process.cwd(), "public", "fonts");
  const [regular, semibold, bold] = await Promise.all([
    readFile(path.join(dir, "Inter-Regular.woff")),
    readFile(path.join(dir, "Inter-SemiBold.woff")),
    readFile(path.join(dir, "Inter-Bold.woff")),
  ]);

  cached = [
    { name: "Inter", data: regular, weight: 400, style: "normal" },
    { name: "Inter", data: semibold, weight: 600, style: "normal" },
    { name: "Inter", data: bold, weight: 700, style: "normal" },
  ];
  return cached;
}
