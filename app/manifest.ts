import type { MetadataRoute } from "next";

// Next.js auto-serves this at /manifest.webmanifest and injects the
// <link rel="manifest"> tag — nothing to wire up in layout.tsx. Icon
// source is app/icon.svg (the existing "b." brand mark, already used as
// the browser-tab favicon), rasterized to PNG since manifest icons need
// broad OS/launcher support that raw SVG doesn't reliably get on Android.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "brohda. — The Social Prediction Platform",
    short_name: "brohda.",
    description: "Predict football outcomes, join community pools, and prove you know the game better than your group chat.",
    start_url: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#4f46e5",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
