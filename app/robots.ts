import type { MetadataRoute } from "next";

// brohda. is invite-only — there is nothing here for a search engine to
// usefully index, and being crawled/indexed would actively work against
// "invite-only" by surfacing the app (and potentially pool content) in
// public search results. Block all crawling; revisit if the product ever
// adds a public marketing surface meant for discovery.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
