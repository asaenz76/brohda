# New-member activation and the return loop (Brohda 2.1 M7)

> Arrive → understand → sign up → make a first Pick → know what happens next → come back for the result → make another Pick.

M7 is an activation milestone, not a mechanic: nothing new to play, nothing to win. It removes the places a new fan got lost between arriving and their first Pick, connects a result to what comes next, and measures the funnel from rows Brohda already keeps. No AI, no money, no prizes, no streaks, no referral or marketing automation, and no change to any threshold (weekly leaderboard minimum 5, profile percentage minimum 5).

## The events (canonical, server truth)

| Event | Definition | Source |
|---|---|---|
| **Activation** | the first valid team-winner Pick | `min(predictions.created_at)` per Member |
| Early retention | a second Pick within 7 days of the first | `predictions` |
| **Return** | after a Pick resolved: another Pick, or opening the "result is in" notification, within 48 h of the first result | `predictions.graded_at/created_at`, `notifications.read_at` |
| Social | first comment / first Call BS | `post_comments`, `challenges` |
| Competitive | ranked on this week's leaderboard | `get_weekly_leaderboard()` |

Signed-out visits and "sign-up started" are **not** in the database and are deliberately not invented: no vendor, no clickstream. (Recommendation in the report if they are ever needed: a privacy-preserving counter, decided separately.)

## What was broken (found by running the journey as a fresh visitor)

1. A signed-out visitor taps a side → signs up → lands on the Post, which had **no Pick control** ("make your prediction in the feed"): the tapped side was lost and the Game had to be found again among 50 cards. (The audit also found the Post's docstring calling this deliberate.)
2. After the first Pick the card gave no acknowledgement, no meaning ("what does this do?"), and still said "Make your pick to see how everyone else picked" to someone who just picked.
3. The profile of a Member with a Pick waiting said "Your record starts with your first pick".
4. A result notification landed on a bare result line: no Record, no way to the next Game.
5. The finished Game's conversation still said "Say why you picked X".
6. Nothing measured the funnel.

## What M7 changes

* **Intent survives sign-up, without saving anything.** Each side on the front door links to `/register?next=/post/<id>?pick=YES|NO` (the existing, open-redirect-safe `next`). The sign-up and log-in screens name the Game ("Carolina Panthers @ Green Bay Packers — Create your account to make your pick on this game."). Back on the Post, `?pick=` is only a hint: "You chose X. Confirm your pick." — the Pick is made only by pressing the button (same `setPickAction`: auth, eligibility, lock, rate limits unchanged). Anything but exactly YES/NO is ignored; a hint can never choose for someone who already picked.
* **The Post carries the Pick control** — the primary Market's, the same component the feed card uses (`getFeedItemForPost` reuses the feed's enrichment) — above the sentiment. No "more markets" block.
* **The first Pick is acknowledged:** "Pick made. It counts toward your Record when the game ends." (then the existing "You can change your pick until it locks", then optional Confidence). The crowd line after a Pick says when the crowd appears ("Your pick is in. You'll see how everyone else picked once it locks or you add Confidence.") — commit-before-crowd is unchanged.
* **The Record explains itself:** with a Pick waiting and no result yet, "Your Record starts when your first game ends. Your pick is waiting for a result."
* **A result connects forward:** on the result page (where the notification lands) and on the Post, a short block: "Your Record is 1–0 · See your Record", the weekly standing while the leaderboard is on ("1 of 5 decided Picks this week to qualify" — decided, never pending), and "Pick another game". Read only when the viewer has a graded Pick on that Market.
* **A finished Game talks about the result** ("Talk about the result."), not "Say why you picked X".
* **Measurement:** migration 220 `activation_funnel_summary()` (read-only, service role only, aggregates only) and a Super Admin report at `/admin/activation`. Percentages are withheld below 30 Members.

## What was audited and deliberately left alone

* The landing page already puts real Games and one clear path (Create account / Log in) in front of a visitor; the headline and tagline are brand.
* The feed order (soonest kickoff, followed Communities first) is documented, deterministic policy; Games that have started are filtered.
* Registration is four single-field screens (name, email, password, username + terms), a deliberate mobile-first pattern recorded in the form; no email verification; auto sign-in; honours `next`. Merging screens is a recommendation, not a change.
* "Result is in" notification copy is Super Admin policy (platform settings); the defaults are not changed here. Recommended wording is in the report.

## Files

Migration `20260101000220_activation_funnel_summary.sql`; `lib/auth/{pick-intent,game-context}.ts`; `lib/communities/feed.ts` (`getFeedItemForPost`); `lib/predictions/result-next-steps.ts`; `lib/predictions/repository.ts` (`countPendingPredictions`); `lib/activation/*`; `components/auth/AuthGameContext.tsx`; `components/posts/{PickIntentConfirm,PublicPickChoices,FeedMarketPick,GameMarketSentiment,PostConversation}.tsx`; `components/predictions/{TwoStepPickComposer,ResultNextSteps}.tsx`; `components/profile/RecordCard.tsx`; pages `app/(app)/post/[id]`, `app/(app)/markets/[id]`, `app/(app)/profile`, `app/(auth)/{register,login}`, `app/(admin)/admin/activation`.
Tests: `tests/unit/activation/*`, `tests/integration/activation.test.ts`, `tests/e2e/activation-flow.spec.ts` (its own Playwright project).
