# Sponsor Intelligence (r77)

Aggregate-only campaign results for Sponsors, with exact numbers for Super Admin. **OFF by default** (`platform_settings.sponsor_intelligence_enabled`, separate from `sponsorship_enabled`, and it fails closed).

## What it is

For one of a Sponsor's own campaigns: how many Members saw it, took part, commented, challenged each other, or came back — plus which sports and Teams those Members care about. Nothing else. A Sponsor can never browse, list, search or export individual Members, and no page, API or function a Sponsor can reach contains a Member id, name, e-mail, profile, Pick history, Confidence, Call BS record, message or rivalry.

## What already existed (reused, not duplicated)

- `sponsorship_exposure_events` (migration 181): an IMPRESSION is a signed-in Member's browser reporting the "Sponsored · Presented by" line ≥ 50% visible for ≥ 1 second (one per Member per UTC day); a CLICK is a request to the first-party `/sponsorship/click/<id>` redirect (Members or anonymous visitors). Internal only: Super-Admin-read by RLS.
- The ordinary `predictions`, `markets`, `post_comments`, `challenges`, `community_follows`, `communities`, `teams` tables. Nothing new is measured and no new tracking exists.

## What is new

| Piece | Where |
| --- | --- |
| Capability + policy (3 settings) | `platform_settings`: `sponsor_intelligence_enabled` (default false), `sponsor_intelligence_min_cohort` (default 10, database floor 2), `sponsor_intelligence_affinity_lookback_days` (default 90) |
| Audited settings change | `admin_set_sponsor_intelligence_config` (Super Admin only; audit `settings.sponsor_intelligence_updated`) — Settings → Brohda → Sponsorship |
| Exact aggregates | `sponsor_intelligence_aggregates(sponsorship_id, lookback_days)` — **service_role only**; returns ONE json document of counts and labels |
| Suppression rule | `lib/sponsor-intelligence/suppression.ts` (pure) |
| Sponsor view / admin view | `lib/sponsor-intelligence/report.ts`; read through `lib/sponsor-intelligence/service.ts` |
| UI | Sponsor: "Results" card on the Sponsor's own campaign page. Super Admin: "Performance (exact)" on the campaign's admin page, beside what the Sponsor would see |

## Who counts

Only Members: `user_profiles.role = 'player'`. Staff accounts (an admin testing a campaign) never inflate a Sponsor's numbers. Sponsor logins have no `user_profiles` row, so they can never be recorded as an impression (the table requires one).

## Figures (V1)

Sponsor Intelligence measures **aggregate attention, participation, prediction behaviour and social engagement** around a Sponsored Game. It measures **no Member money** — real-money Member P2P is retired as a product direction, so nothing about wallets, stakes, Positions, P2P settlement, fees or balances is read, carried or shown (static guards in `tests/unit/sponsor-intelligence/no-monetary.test.ts` fail if the aggregate SQL or the domain code ever reaches for a monetary table or term). Legacy monetary data is operational leftovers, not Sponsor analytics.

Counted inside the campaign's presentation window (its `starts_at` until the earlier of `ends_at` and now):

- **Reach:** Members who saw it (distinct Members with an impression), **repeat viewers** (seen on at least two different days — impressions are stored once per Member per day, so this is directly measurable), impressions, link clicks.
- **Predictions:** Members who made a Pick and Picks made (on any Market of the sponsored Game); the **participation rate** — of the Members who saw it, the share who also made a Pick (a valid denominator because the numerator is a subset of the viewers); and **Picks by Market** — per Market, how many Members picked it and, when each side is large enough on its own, the split between the two sides.
- **Conversation:** Members who commented, comments (top-level) and replies, on the Game's Post (not deleted).
- **Call BS (free, social):** Members in a Call BS, challenges, accepted challenges, the **acceptance rate** (accepted of challenged) and the **engagement rate** (of the Members who made a Pick, the share who joined a Call BS).
- **Loyalty:** returning Members — Members who picked in this campaign AND on another LIVE/COMPLETED campaign of the same Sponsor.
- **Audience:** for the Members reached, the sports they also pick (within the look-back) and the Team communities they follow. Counts overlap (one Member can appear in several sports/Teams), so no total is shown beside them.

**Pick sentiment** uses the product's one calculation (`computePickSentiment`) and the shared label helper (`getChoicePresentation`), so a Sponsor reads "Chiefs 62% · Ravens 38%" exactly as the Member product words it. It is stricter than the Member rule: the split is shown only when the Market's Members are shown AND both sides are individually at least the threshold (a 19–1 split would point at one person).

**Rates** are computed only from two figures that are BOTH shown. A rate whose figures are withheld is withheld; a rate with nothing to measure yet (a shown zero denominator) reads "—".

**Not built:** geography (the platform holds no trustworthy location data — `user_profiles` has no country or region — so nothing is reported rather than invented; add it only when a legitimate, reliable, privacy-safe source exists); anything about Confidence, Messaging, Rivalry, Recovery or anti-abuse signals.

## Small-cohort suppression

Applied when the Sponsor view is built, from the single threshold `k` in settings. A figure based on fewer than `k` Members/events is shown as "Not enough data yet". A zero is shown (it identifies nobody).

- An event total is withheld when the Members behind it are a small group (45 impressions from 3 Members would point at 3 people).
- A subset (returning Members, repeat viewers, viewers who picked, accepted challenges, pickers in a Call BS) is shown only when its remainder (the total minus the subset) is also zero-or-at-least-`k` — otherwise the subtraction would reveal a small group — and only when its parent figure is shown.
- A breakdown hides small cells and merges them into "Other", shown only if that merged figure is itself ≥ `k`.
- A malformed or too-low threshold never loosens privacy: it is treated as "show nothing". The capability itself is OFF whenever the threshold or look-back cannot be read as a valid value.

## Authorization

| Who | Can |
| --- | --- |
| Member | Nothing. No route, API or RLS path reads any of it. |
| Sponsor | The suppressed Results card for their OWN campaign, only while the capability is ON. Another Sponsor's campaign, a Member's request or a missing id all return the same not-found. |
| Admin (non-super) | Nothing. |
| Super Admin | Exact figures on every campaign, the settings, and the audit trail. Works whether or not the capability is ON. |

Reads happen on the server through the service role after the ownership check. There is no JSON endpoint to leak: the Sponsor page is a server component.

## OFF means off

When OFF: Sponsors see no Results card and no hint it exists; internal measurement continues unchanged; Super Admin keeps the exact figures. Turning it OFF takes effect on the next request — no deploy, no cache.

## Not built (by design, this milestone)

Exports, per-Member lists, geography, Sponsored Confidence intelligence (waits for Sponsored Confidence Drops), alerts, benchmarks across Sponsors, any Member-facing change, Messaging, Confidence.
