# SEO audit (r42) — recommendations only

Audit date: 2026-10-06. **Nothing about indexability was changed.** The only edits are two stale code comments (`app/robots.ts`,
`app/layout.tsx`) that still said the product is "invite-only"; they now say what the setting actually is. Observed on production
(read-only) and in the code.

## Current state

| Surface | What it does today |
|---|---|
| `/robots.txt` | `User-agent: *` / `Disallow: /` — all crawling blocked |
| Every page | `<meta name="robots" content="noindex, nofollow">` (root layout; also set per page on `/terms`, `/privacy`) |
| `/sitemap.xml` | does not exist (404) |
| `<title>` / description | present and specific on `/`, `/rules`, `/terms`, `/privacy` |
| Canonical URL, Open Graph, Twitter cards | none |
| Public pages | `/` (front door with real Game Posts), `/rules`, `/terms`, `/privacy`; Game Post detail pages need an account |

Note the two blocks (robots.txt disallow **and** noindex) interact badly if indexing is ever wanted: a crawler that is disallowed never
sees the `noindex`, and a page that is both blocked and linked can still appear as a bare URL. They must be changed together.

## The decision (owner)

Is brohda. meant to be discoverable? The product now has a public front door and open registration, so the "invite-only" reason for
blocking no longer holds — but whether to be indexed is a product/legal/brand call, not an engineering one.

### Option A — stay unindexed (no work)
Keep everything as is. Zero risk; no organic discovery.

### Option B — index only the public, evergreen pages (recommended if discovery is wanted)
Allow `/`, `/rules`, `/terms`, `/privacy`; keep everything behind login and all of `/api`, `/admin`, `/accept-terms`, `/login`,
`/register`, `/invite` out. Needs, in this order:

1. `robots.ts`: allow the four paths, disallow the rest; reference the sitemap.
2. Remove `robots: noindex` from the root layout default and from those four pages; keep it on every authenticated/utility route
   (set per route group, not by default, so a new private page can't become indexable by accident).
3. A `sitemap.ts` listing only those four URLs.
4. `alternates.canonical` on each, and Open Graph / Twitter metadata (title, description, one share image) on `/`.
5. `/rules` is rendered live from platform settings (cutoff, fee, limits). That is fine for indexing, but it means a crawled snapshot can
   quote a limit that later changes — acceptable, worth knowing.
6. Decide whether the logged-out Game list on `/` (real fixtures, comment counts, **no** sentiment since r42) should be indexable; it
   changes constantly, so it is the weakest candidate — indexing only the static pages is a valid middle.

### Option C — index Game Posts too
Needs a public, logged-out Game Post page (does not exist today), per-Game metadata, and a stale-content policy for finished Games.
That is a feature, not an SEO tweak — out of scope here.

## Risks of changing it
- Terms/Privacy contain statements flagged OWNER/COUNSEL REVIEW REQUIRED (`docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md`);
  indexing them publishes those exact words widely. Resolve the legal review (and the unchosen effective date) first.
- The public front door must never show private data (it shows counts only; verified by `tests/e2e/public-front-door.spec.ts`).
- Money Positions are private to the two members; none of that appears on any public page.

## Not recommended
Do not add `Allow` for `/api`, `/admin`, `/feed` or `/profile`; do not rely on robots.txt alone to hide a page.
