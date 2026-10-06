import type { MetadataRoute } from "next";

// Crawling is currently blocked for every path, and every page also carries `robots: noindex` (app/layout.tsx). That is a deliberate
// current setting, NOT a statement that the product is private: the public front door ("/"), /rules, /terms and /privacy are open to anyone.
// Whether any of them should be discoverable in search is an owner decision (see docs/SEO_AUDIT.md for the options and what each would
// need). Changing it means changing this file, the root `robots` metadata and the per-page `robots` entries together.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
