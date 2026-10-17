# Game Previews and the Post (r91, migration 206)

**Canonical split: FEED = PREDICT, POST = GAME PREVIEW + CONVERSATION.** The feed owns every prediction (Moneyline, Total, Spread, Confidence, commitment, sentiment, locked state). The opened Post carries what the feed does not: the Game, how the crowd picked on each Market, a short editorial **Game Preview**, the one shared conversation, and Other Picks / Call BS. It is not a second prediction surface: no Pick buttons, no Confidence control, no "more markets" links. (The Market page `/markets/[id]` keeps its full card; nothing links to it from the Post any more.)

## Feed
Every Game card has an explicit, always-visible text link **Game Preview** (accent colour + chevron, never icon-only, never hover-only) beside the matchup title (below it on a phone, where the title takes the row), `data-slot="game-preview-link"`, accessible name "Open game preview for {away} at {home}". It links to the canonical Post — there is no second Preview page. The matchup title stays a secondary path to the same place. The link needs only the Post id the card already has: the feed fetches no Preview text. It is present for any Game with a Post, whether or not a Preview has been written yet.

## Post
Order: Game identity → Market sentiment (Moneyline, Total, Spread in the configured template order) → Game Preview (hook, story) → Sponsor promotion (if any) → Conversation → Other Picks / Call BS. A Game with no saved Preview simply has no Preview block (no placeholder, no error).

**Sentiment** (`lib/posts/game-sentiment.ts`, `components/posts/GameMarketSentiment.tsx`) obeys the product's commit-before-crowd rule per Market: percentages and the predicted count appear only once the viewer's own prediction on THAT Market is final; before that the block says "Make your pick in the feed to see how everyone else picked." One Pick is one vote (Confidence never weights it), the numbers are the canonical Pick aggregate, a Market nobody has picked says "No one has predicted yet" (never 0% / 0%), and a single Pick is a real 100% / 0%. Labels are the shared team-native choice labels (NHL stays canonical SPREAD with puck-line wording). Each block also carries the viewer's own prediction as context ("Your prediction: Washington Capitals · 🔥5 · Result: Correct") — a line, not a card. One batched read however many Markets the Game has.

## Storage (migration 206)
| Table | Purpose |
|---|---|
| `game_preview_config` | one row: `max_chars` (700), `hook_max_chars` (120), `lead_hours` (48), `stale_after_hours` (36), `min_refresh_interval_hours` (6). Nothing is hard-coded in code; changed by a Super Admin (audited `settings.game_preview_updated`) at **Admin → Game Previews**. |
| `game_previews` | the CURRENT Preview of a Game (unique per fixture): hook, body, `status` PUBLISHED/WITHDRAWN, `generated_by`, `generated_at`, `checked_at`, `refresh_count`, `frozen_at`. |
| `game_preview_sources` | provenance: URL, provider, title, `published_at`, `retrieved_at`, `supports` — required and validated; not shown to Members. |
| `game_preview_revisions` | every Preview a refresh replaced (text, sources, why). |

No Member or anonymous role can read or write any of them (RLS, no policy, no grants); the Post reads through the server.

## Writing — one validated function
`upsert_game_preview(fixture, hook, body, generated_by, reason, sources)` (service role only; `saveGamePreview` in `lib/game-previews/repository.ts`). It refuses: text that is empty or longer than the configured limits (nothing is padded or cut); a Preview without complete provenance (1–12 sources, each an http(s) URL + provider + title + a retrieval time that is not in the future); a Game that has started (`game_started` — the pregame Preview is frozen at kickoff and never rewritten); an unknown reason. Reasons: `MISSING` (create; or recreate after a withdrawal), `STALE` (only when `checked_at` is older than `stale_after_hours`), `NEW_STORY` (only when the Preview is older than `min_refresh_interval_hours`), `CORRECTION` (always, before kickoff). A refresh keeps the replaced version in `game_preview_revisions`. Concurrent writers are serialized per Game by an advisory lock (exactly one `created`).

## When and by whom
**Never at render time.** Pipeline: Game scheduled → (background) research → Preview written and verified → saved through `upsert_game_preview` → the Post reads the saved row. `game_preview_candidates()` lists published, unstarted Games starting within `lead_hours` that have no Preview (or a withdrawn one) or whose last check is older than `stale_after_hours`. The existing housekeeping job (`/api/cron/prune-provider-request-log`, no new scheduler entry) runs `runGamePreviewHousekeeping`: it **freezes** the Preview of every Game that has started and reports how many Games still need one (`gamePreviews: { frozen, missing, stale }` in the job result). It writes no editorial text: the research-and-writing step is a separate producer that calls `saveGamePreview`.

## Factual standard
Every claim must come from verified material tied to that specific Game (recent results, a player streak, an injury or return, a milestone, head-to-head history, a record chase, an unusual statistic). If there is no strong angle, a simpler verified factual preview is correct. The style references in the product spec are tone only; their facts are never reused for another Game. Each Preview is stored with its sources and when they were retrieved, so an operator can audit it.

## Operator tools (Admin → Game Previews, Super Admin)
Limits and timings; the next 14 days of published Games with their status (needs a Preview / saved / stale / withdrawn); each saved Preview with its generator, timestamps, refresh count and a collapsible source list; and **Withdraw** (requires a reason; audited as `game_preview.withdrawn`; hides it from the Post immediately; text and sources stay on record; a new Preview can then be written).
