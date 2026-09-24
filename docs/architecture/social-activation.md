# Controlled Social Activation (Milestone R13.10)

Documents the staged production activation of Brohda 2.0's free social
prediction lifecycle (Game → Market → Post → Community distribution →
Pick → lock → grade → permanent record → notification), one stage at a
time, each independently verified in production before the next begins.

## Stage 0 — the user-facing activation boundary

R13.8/R13.9 both deliberately deferred a known architectural gap:
`market_ingestion_enabled`/`post_publication_enabled`/`community_
distribution_enabled` gate whether Brohda's backend jobs *prepare*
content — they were never meant to, and never did, control whether an
ordinary authenticated user could *reach* the resulting pages
(`/markets`, `/markets/[id]`, `/post/[id]`, `/community/[slug]`,
`/leaderboard/predictions`) directly. **DEPLOY != ACTIVATE** requires a
fourth, independent gate specifically for user-facing exposure, so the
content pipeline can run and be verified against real production data
while ordinary users still see nothing.

**`platform_settings.social_prediction_enabled`**
(`20260101000167_social_prediction_visibility.sql`) is that gate. Default
`false` — deploying this migration and its application code exposes
nothing on its own. Placed in the existing "Markets" admin-settings
domain/RPC (`update_market_settings`) rather than a new domain, since
that's the closest existing activation-flag cluster and a whole new
settings-UI card for one boolean would be disproportionate.

**Enforcement**: `lib/social/access.ts`'s `requireSocialPredictionAccess()`
mirrors `requireSuperAdmin()`/`requireAdminOrAbove()`'s own exact shape
(`lib/auth/session.ts`) — authenticate first, then check access, redirect
to `/feed` (the legacy product's own home, never a dead end) if denied.
Called at the top of each of the five gated pages' own Server Component,
**not** in middleware and **not** only via hidden navigation — direct URL
access is checked exactly where every other page-level auth guard in this
codebase is checked. `is_super_admin`/`admin` roles always pass,
regardless of the flag, for operational preview — the same precedent
`requireAdminOrAbove()` already establishes for admin-adjacent pages.

**Navigation**: the "Markets" bottom-nav tab (`components/
MobileBottomNavigation.tsx`) is hidden for ordinary users when the flag is
off, computed once per request in `app/(app)/layout.tsx` and threaded
through `AppShell`. This is a UX signal only, not the enforcement layer —
removing it would not by itself expose or hide anything, since the pages
enforce independently.

**Not gated by this flag**: `/my-picks` (a pure redirect stub to
`/profile`, not itself Brohda 2.0 content) and `/profile`'s own "Market
Predictions" tab (a sub-tab within an otherwise-legacy, always-accessible
page — full tab-level gating was judged disproportionate to this stage's
scope and is a known, documented residual gap, not a silent omission).

## E2E baseline note

Nearly every existing Brohda 2.0 E2E spec (discovery-markets,
predictions-flow, call-bs-challenges, monetary-challenge-position,
p2p-settlement, reputation-leaderboards, post-conversation) navigates an
ordinary test user straight to a now-gated page and asserts on real
content — none of them test the access gate itself. Rather than touch
every spec file, `tests/e2e/helpers/global-setup.ts` sets `social_
prediction_enabled = true` once for the whole E2E run.
