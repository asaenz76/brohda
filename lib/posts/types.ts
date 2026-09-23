// Milestone R3 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Foundation).
// A Post is Brohda's own canonical SOCIAL representation of a Game — never
// sports truth (that's `fixtures`), never a Market proposition, never a
// Pick. See docs/architecture/post-foundation.md for the full domain
// rationale.

export interface Post {
  id: string;
  fixtureId: string;
  /** Null = exists but not yet publicly visible. Non-null = the moment it became visible. */
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostPublicationPolicy {
  enabled: boolean;
  requiresActiveMarket: boolean;
  primaryMarketTemplatePriority: string[];
}
