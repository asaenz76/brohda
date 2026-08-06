# THE_LAST_50_PERCENT_REPORT.md

**Founder's memo. 30 days to launch. No more engineers, no more budget, no more time. Cut the product in half.**

Four reports got us to understanding. This one is the cut. No summaries, no re-litigating — every feature is guilty until it proves it belongs, and the burden of proof is on the feature, not on me.

---

# Part 1 — What Is Brohda?

**"Brohda is where football friends prove who calls it best."** (10 words.)

That's the whole product. Everything below either serves that sentence or it's gone.

---

# Part 2 — The Nuclear Test

Everything is gone. 30 days. Here's what gets rebuilt first, in order, and nothing else until these five are real:

1. **The feed.** Without it there's no product — it's not a feature, it's the building.
2. **Entering a prediction — one type, fixed fee, one confirm.** This is the verb. No verb, no game.
3. **Comments.** This is what turns a bet into a story people tell. Skip this and Brohda is just a ledger with football attached.
4. **A wallet balance + the simplest possible way to add money.** Not the whole payment-ops machine — just: see your number, get more of it, trust it's right.
5. **A leaderboard.** The scoreboard is what makes "I was right" mean something beyond one conversation. Without it, every win evaporates the moment the thread scrolls away.

Everything else — wallet forms beyond the minimum, notification types, admin tooling, settings screens, analytics — waits. All of it. No exceptions, no "just this one small thing."

---

# Part 3 — Feature Trial

*Guilty until proven innocent. Y = yes, N = no, ~ = partial/rare.*

| Feature | Purpose | Frequency | Emotion | Complexity | Missed? | New-user clear? | Builds identity? | Verdict |
|---|---|---|---|---|---|---|---|---|
| Feed | The product | Every session | Curiosity | Low | Y | Y | — | **KEEP** |
| Enter a pool (fixed fee) | The verb | Constant | Anticipation | Low | Y | Y | Y | **KEEP** |
| Comments + mentions | Social spine | Frequent | Belonging | Low | Y | Y | Y | **KEEP** |
| Likes | Cheap affirmation | Constant | Mild pride | Low | ~ | Y | N | **KEEP** |
| Sentiment bar | Contrarian-story engine | Constant | Curiosity | Low | Y | Y | Y | **KEEP, amplify** |
| Avatar stack | Social proof | Constant | Belonging | Low | ~ | Y | N | **KEEP** |
| Sharing | External bragging | Rare | Pride | Low | N | Y | N | **KEEP, cheap to keep** |
| 5 pool types | Coverage | Uneven | Confusion | High | N | N | N | **REMOVE 3, keep 2** |
| 17 templates | Coverage | Long tail rarely used | None | High | N | N | ~ | **REMOVE 12** |
| COMBO pools | Parlay mechanic | Rare | Anxiety | High | N | N | N | **REMOVE** |
| Bookmaker-odds engine (player-visible) | "Better" questions | Invisible to players when working | None | Medium | N | N/A | N | **REMOVE from player surface** |
| 6 payment rails | Coverage | Constant admin overhead | Decision fatigue | High | N | N | N | **REMOVE 5** |
| Wallet request/approval flow | The only way money moves | Every deposit | Anxiety | Medium | Y, structurally required | ~ | N | **SIMPLIFY, keep the model** |
| Participation visibility (4 states) | Control | Set-once | None | Medium | N | N | N | **REMOVE** |
| Pool visibility (public/hidden) | Private side-bets | Rare | Neutral | Low | ~ | Y | N | **DEFER, low cost to keep** |
| Follows (user) | Core social graph | Constant | Belonging | Low | Y | Y | Y | **KEEP** |
| Team/league follows + per-follow email toggles | Granular notification control | Set-once | None | Medium | N | N | N | **MERGE to one global setting** |
| Streaks | Momentum, pride | Passive, always visible | Pride | Low | Y | Y | Y | **KEEP, amplify** |
| Leaderboard (6 view combos) | Ranking | Frequent | Pride | Medium | Y (the ranking), N (the combos) | ~ | Y | **SIMPLIFY to one default** |
| Player analytics dashboard | Self-insight | Rare | None | High | N | N | N | **REMOVE as a destination** |
| My-picks page | ? | Rare | None | Low | N | N | N | **MERGE into Profile** |
| Rules page | Explain mechanics | Once | None | Low | ~ | Y | N | **SIMPLIFY to a help sheet** |
| Notifications | Keep informed | Constant | Mixed | Medium | Y | ~ | ~ | **SIMPLIFY copy, keep mechanism** |
| Activity/history | Trust | Occasional | Trust | Low | Y | Y | N | **KEEP** |
| Search (users) | Find a friend | Rare | Neutral | Low | Y | Y | N | **KEEP, it's cheap** |
| Admin: competitions/fixtures pipeline | Make pools possible at all | Constant (admin) | N/A | High | N/A (invisible to players) | N/A | N/A | **KEEP, necessary machine** |
| Admin: competition workspace (5 sub-tabs) | Manage the machine | Occasional | N/A | High | N/A | N/A | N/A | **MERGE to 2 tabs** |
| Admin hierarchy tree | Org structure | Never at current scale | N/A | Medium | N/A | N/A | N/A | **REMOVE** |
| Provider status panel (screen) | Ops safety visibility | Rare | N/A | Medium | N/A | N/A | N/A | **DEMOTE to an indicator** |
| Reports (admin) | ? | Unknown if ever opened | N/A | Low | N/A | N/A | N/A | **DEFER until someone asks for it** |

The pattern, once every row is scored: **everything that survives with a clean KEEP is person-facing and cheap. Everything marked for removal is either system-facing, rarely used, or both.** No exceptions found.

---

# Part 4 — The One-Year Test

**COMBO pools, one year in — would anyone complain if it vanished?** No. It's used by a role gated to one or two people, on a mechanic nobody in a friend group asked for.

**Player analytics dashboard, one year in — missed?** No. The two numbers anyone actually checks (win rate, streak) will already live on Profile by then.

**Participation visibility's 4 states, one year in — missed?** No. Nobody will remember it existed, because nobody chose it in the first place — it defaulted correctly and sat there, unused, the whole time.

**Admin hierarchy tree, one year in — missed?** Not by a single player, ever, under any circumstance. It doesn't touch the product they use.

**Six payment rails, one year in — missed?** The five that get cut, no. The one that survives is the one anyone would have picked anyway.

**The feed, comments, the leaderboard, streaks — one year in, if any of these vanished?** Loud, immediate, justified complaints. This is the test that separates the core from the padding, and it separates cleanly, every time.

---

# Part 5 — The Friend Test

*"I called the upset." "My streak reached eight." "I beat everyone." "I was the only one." "My friend was so sure." "My profile is known for..." — does the feature ever appear in one of these sentences?*

**Appears in these stories:** the feed (where the story happens), entering a prediction (the "call" itself), the sentiment bar (the "everyone but me" story), streaks (literally the sentence), the leaderboard (the "beat everyone" story), comments (where the story gets told), identity/reputation, once built (the "known for" story).

**Never appears in any of these stories, ever, in any plausible conversation:** participation visibility settings, payment-rail choice, per-follow email granularity, the analytics dashboard, the admin hierarchy tree, the provider status panel, template selection mechanics, void-reason taxonomy.

**The verdict writes itself.** Every feature in the second list is on notice. None of them can generate the one thing this product needs more of — a sentence a real person says to a real friend, unprompted, tomorrow.

---

# Part 6 — Identity Test

*Does this help someone become memorable? Build reputation? Create conversation?*

**Passes:** streaks, the sentiment bar's contrarian calls, the leaderboard, comments, the reputation/identity layer (already decided, see the implementation plan — this test is the reason it's the single highest-priority net-new thing worth building).

**Fails, decisively:** every setting on the cut list from Part 3. Not one of them makes anyone more memorable to anyone else. A setting, by definition, is something you configure privately — the opposite of something that makes you known.

**The rule going forward:** any feature proposed after this report has to answer this test before it answers any other question. If it can't make someone more memorable, it doesn't get built, no matter how useful it sounds in isolation.

---

# Part 7 — Feed Test

*Does this improve scrolling, conversation, prediction quality, or reputation — or is it just another screen?*

- **Improves scrolling:** fewer pool types (faster card comprehension), reordered card hierarchy (person-first).
- **Improves conversation:** comments, the sentiment bar, streaks becoming visible moments.
- **Improves prediction quality:** honestly, almost nothing on the current feature list — this product isn't selling edge, and any feature that tried to (the odds-recommendation engine) is being removed from player view precisely because "improving prediction quality" isn't the goal.
- **Improves reputation:** streaks, leaderboard, the identity layer.
- **Just another screen, contributing to none of the above:** My-picks, the analytics dashboard, Fixture Archive, Reports, the provider status panel, the admin hierarchy. Every one of these is being cut or merged in Part 17.

---

# Part 8 — Emotional Return

| Feature | Emotion | Verdict |
|---|---|---|
| Feed | Curiosity | Real, keep |
| Entering a pool | Anticipation | Real, keep |
| Sentiment bar | Curiosity | Real, keep |
| Streaks | Pride | Real, keep |
| Leaderboard | Pride | Real, keep |
| Comments | Belonging | Real, keep |
| Wallet balance | Confidence (should be) | Real, protect and fix the surrounding flow |
| Win notification | Should be pride, currently flat | Fix the copy/weight, don't cut the mechanism |
| Participation visibility | **None** | Administration — cut |
| Payment rail selection | **None, plus anxiety** | Administration with a negative charge — cut hardest |
| Admin hierarchy | **None** | Pure administration — cut |
| Analytics dashboard | **None** | Administration wearing a chart — cut as a destination |
| Void-reason taxonomy (raw) | **None, or mild confusion** | Administration leaking into a moment that should carry feeling — rewrite, don't just cut |

**The rule stated in the brief is correct and confirmed by every row above: no emotion means administration, and administration disappears wherever it can.**

---

# Part 9 — Complexity Budget

*100 points, spent honestly across what the product actually is today.*

| Area | Points spent today | Justified spend | Overspend |
|---|---|---|---|
| Feed + cards | 12 | 12 | — |
| Predictions (pool types, templates, entry) | 20 | 8 | **12 points of overspend** — this is where most of the fat is |
| Wallet (balance, deposit/withdraw, rails) | 12 | 6 | **6 points of overspend**, concentrated entirely in rail choice and form friction |
| Comments/likes/social | 8 | 8 | — |
| Leaderboard/streaks/identity | 6 | 10 | **Underspent** — this deserves more investment, not less |
| Profile + settings (visibility toggles, fields) | 8 | 3 | **5 points of overspend** |
| Notifications | 5 | 3 | 2 points of overspend, mostly copy debt, not structure |
| Analytics (player) | 4 | 0 | **Full overspend — cut entirely** |
| My-picks / Fixture Archive / Rules-as-a-page | 4 | 0 | **Full overspend — merge away** |
| Admin: competitions/fixtures pipeline | 10 | 10 | Necessary — this is the machine that makes the feed possible |
| Admin: hierarchy, provider-status screen, workspace sub-tabs | 6 | 1 | **5 points of overspend** |
| Auth/invitations | 5 | 5 | — |

**Total today: 100. Total justified: ~66.** Roughly a third of the product's complexity budget is spent on things that create no emotion and appear in no story anyone tells a friend. That third is exactly what this report cuts.

---

# Part 10 — Duplicate Concepts

- **Two profile views:** Profile's own predictions tab vs. My-picks as a separate page. **One canonical solution: Profile.** My-picks disappears.
- **Two "who am I as a predictor" views:** Profile's basic stats vs. the standalone analytics dashboard. **One canonical solution: Profile**, carrying the two numbers that matter (win rate, streak, soon identity). The dashboard disappears as a destination.
- **Two match-context views:** Fixture detail vs. Pool detail, with no self-evident distinction between them. **One canonical solution: Pool detail**, with fixture context folded in as a section, not a separate screen.
- **Two money surfaces:** the Wallet screen's balance/deposit view and Activity's transaction history, currently split across two places a user has to remember to check separately. **One canonical solution: keep them merged exactly the way Activity already merges notifications and history** — extend that same logic so Wallet is where you act, Activity is where you review, and neither pretends to be the other.
- **Two notification surfaces:** the ephemeral toast and the persisted Activity feed are, conceptually, the same information at two moments in time — not two systems. **Keep this exactly as-is**, but make sure the product never treats them as separate concepts in copy or design; the toast is a preview of Activity, nothing more.
- **Two navigation paths to "who's around":** Search, and browsing followers/following lists. This one is fine as two paths — they serve genuinely different intents (find someone new vs. review who you already follow) — **no change needed here.**

---

# Part 11 — Founder Bias

Built because it sounded good, not because anyone demanded it: **COMBO pools. The admin hierarchy tree. The 17-template registry. The bookmaker-odds recommendation engine. Four-state participation visibility. Six payment rails. The player analytics dashboard.**

Every one of these is competent, well-built, and completely optional. None of them were requested by a user. All of them are cut or reduced in this report.

---

# Part 12 — Product Drift

**Toward a sportsbook:** COMBO pools and the odds-sourced recommendation engine, both of which import betting-industry patterns wholesale. *Why it happened:* those patterns are familiar and well-documented in the adjacent industry, so they're easy to reach for. *Reversal:* remove both from anywhere a player can see them (Part 3).

**Toward a banking app:** the wallet's request-and-wait, six-rail, proof-of-payment flow. *Why it happened:* solving for "we have no payment processor" pulled the design toward the most cautious, most bureaucratic version of a manual process. *Reversal:* one rail, plain language, a stated timeline — the caution can stay, the bureaucracy can't.

**Toward an analytics dashboard:** the player analytics page. *Why it happened:* the data was already computable, so building a screen for it felt free. *Reversal:* cut the screen, keep the two numbers, put them where a person already is (Profile).

**Toward admin software:** the competition workspace's 5 sub-tabs, the hierarchy tree, the provider-status screen. *Why it happened:* real operational problems (quota, sync, org structure) got solved with real UI, and the UI kept growing because nothing was pruning it back. *Reversal:* merge, demote, or remove — none of this touches a player, so none of it needs to be a destination.

**Toward fantasy sports or a prediction market:** no meaningful drift found in either direction. Brohda stays per-match, not per-season, and its sentiment bar stays a social signal, not a price. Protect this — it's the one direction the product hasn't drifted, and it should stay that way deliberately.

---

# Part 13 — The Steve Jobs Test, Per Screen

| Screen | Delete immediately | Simplify | Insist it remains |
|---|---|---|---|
| Feed | — | Card hierarchy reorder | The whole thing, untouched otherwise |
| Pool detail | Rule-pill prominence | Fewer question types | The slide-to-confirm gesture |
| Fixture detail | The screen itself, merge it | — | — |
| Wallet | Five of six payment rails | The request form | The balance display |
| Profile | The three-way visibility toggle | Bio/settings placement | Win rate/streak, promoted |
| Leaderboard | The scope/range matrix as a gate | — | The ranking itself |
| My-picks | The whole screen | — | — |
| Analytics | The whole screen as a destination | — | The two numbers, moved to Profile |
| Notifications/Activity | Raw jargon | Copy voice | The mechanism itself |
| Admin: hierarchy | The whole feature | — | — |
| Admin: provider status | As a screen | Demote to an indicator | The underlying safety logic |
| Admin: competitions | — | 5 tabs → 2 | The pipeline itself — necessary |

---

# Part 14 — The Instagram Test

| Screen | Verdict | Why |
|---|---|---|
| Feed | "This feels social." | Card layout, avatars, comments, likes — this is the room, correctly built |
| Pool detail | "This feels social," mostly | Undermined only by rule-pill/status-notice prominence |
| Wallet | **"This feels like software."** | Forms, fields, waiting — nothing about it feels like a person built it for another person |
| Profile | "This feels like software," partially | Bio/settings-first instead of identity-first pulls it away from "social" |
| Leaderboard | "This feels like software," partially | The decision gate in front of the ranking is a UI concern, not a social one |
| Analytics | **"This feels like software."** | Charts, filters — no social framing at all |
| Admin (any of it) | "This feels like software." | Correctly so — admins aren't the audience for social design, and this isn't a criticism of the admin surface, only confirmation it should never leak into the player experience |

**The fix, every time it's needed:** the gap between "social" and "software" is never a missing feature. It's missing *people* — put a name, a face, or a story back at the top of the screen, and the software feeling recedes.

---

# Part 15 — The Emotional Audit

**What someone remembers tomorrow:** the friend who was the only one who called it right. Their own streak, still alive. A comment thread that got heated about a rivalry match. The specific feeling of watching a bet they made pay off in a group they belong to.

**What they immediately forget:** which payment rail they used. Whether their profile bio was visible to strangers. Which of four visibility settings a pool they entered had. What a "grading version" is. Any status notice phrased in a code they didn't recognize. The existence of an analytics dashboard they opened once.

**Why the gap:** the remembered list is entirely people and stakes. The forgotten list is entirely settings and system state. This is the same finding as every other section in this report, arrived at from yet another angle, which is itself the confirmation that it's correct.

**Delete everything on the forgettable list wherever deletion is possible; wherever it isn't (the wallet has to exist), rewrite it until it's at least invisible rather than actively memorable-for-the-wrong-reasons.**

---

# Part 16 — What Would Hurt?

*Ranked by how much removing each one would genuinely damage the product.*

1. **The feed.** Catastrophic. There is no Brohda without it.
2. **Entering a prediction.** Catastrophic. This is the one verb the entire product exists to let someone perform.
3. **Comments.** Severe. Without them, every prediction is a private transaction instead of a public story.
4. **The wallet (in some form).** Severe. Without real stakes, nothing else means anything — this is the thing that makes #1–3 matter.
5. **The leaderboard/streaks.** Significant. Without a scoreboard, being right stops compounding into anything.
6. **Follows.** Moderate. The feed still functions without it, but it stops being *your* feed.
7. **Likes/sharing.** Mild. Nice, cheap, not load-bearing.
8. **Everything else on the cut list from Part 3.** Negligible to zero. This is exactly why it's cut.

**Items 1 through 5 are Brohda's core.** Everything below that line is optional, in exactly the order listed.

---

# Part 17 — The Last 50%

*Exactly what ships in 30 days. Everything else waits, indefinitely, until it re-earns its place.*

**Survives:**
- The feed, exactly as it is today, with the card-hierarchy reorder already decided
- Entering a pool — **one pool type** (a straightforward result prediction), **a handful of simple binary questions**, nothing else
- Comments, mentions, replies, likes, sharing — untouched
- Follows (people only — team/league follows wait)
- Wallet: balance display, **one payment rail**, a simplified request form with a stated timeline
- Streaks and the leaderboard, **defaulted to one view, no scope/range picker at launch**
- The sentiment bar
- Activity (merged history + notifications), with rewritten, jargon-free copy
- Profile, reordered to lead with identity/track record, carrying win rate and streak — **the full standalone analytics dashboard does not ship**
- Search (users)
- The minimum admin surface required to actually run the product: import a fixture, create the one supported pool type, grade it, approve a wallet request
- Invitations, as the only door in

**Does not survive launch, deferred indefinitely, revisited only if real demand shows up:**
- COMBO pools
- 4 of the 5 pool types
- All but ~5 of the 17 templates
- 5 of the 6 payment rails
- Participation visibility settings
- Per-follow email granularity
- The bookmaker-odds recommendation engine, anywhere player-visible
- My-picks, Fixture Archive, the standalone Rules page, the standalone Analytics page
- The admin hierarchy tree
- The provider status panel as a screen
- The competition workspace's extra sub-tabs
- Reports
- Team/league follows (fold into user follows only, for now)

**This is not a smaller Brohda. It's the same product, with everything that never appeared in a single "I called it" sentence removed from the launch surface.** The goal was never minimalism for its own sake — it was making sure the thing that ships in 30 days is instantly, completely understandable the moment someone opens it, with nothing left to explain.

---

# Part 18 — The Five Untouchables

1. **The feed's card-based, person-first layout.** This is the product's entire visual identity. Change its fundamental shape and Brohda stops looking like anything.
2. **The slide-to-confirm entry gesture.** The one moment that should feel deliberate, and it already does. Don't streamline away the one piece of intentional friction that's actually earning its place.
3. **Comments, exactly as they work today.** Simple, human, already the product's real social engine. No structural change, ever, without a very good reason.
4. **The fixed, equal entry fee.** The single mechanical fact that makes "who knows the game best" an honest question instead of a pay-to-win one. This does not become variable, ever, for any reason, including a beta-testing convenience.
5. **The one-sentence identity.** Not a feature — a discipline. Every future decision gets measured against "Brohda is where football friends prove who calls it best," and nothing ships that a stranger couldn't fit into that sentence.

---

# Part 19 — The Five Biggest Mistakes We Could Make

1. **Adding a second pool type back before the first one has actually gotten boring.** Prevention: require real, repeated, specific user requests — not hypothetical coverage — before touching pool-type count again.
2. **Adding more settings, one at a time, each individually reasonable.** Prevention: every new setting has to remove or merge an existing one; net-neutral or net-negative, permanently.
3. **Turning the identity/reputation system into a badge collection.** Prevention: re-read Part 4 of the implementation plan before building anything here — computed, never chosen, never permanent, or don't build it at all.
4. **Letting the admin surface grow to match the operational ambition of the team, rather than the actual needs of the product.** Prevention: every admin screen gets the same "would removing this hurt" test as every player screen, on a recurring basis, not just once at launch.
5. **Adding automated payment rails or financial sophistication before the social product has fully proven itself.** Prevention: money infrastructure investment should always lag social-product proof, never lead it — this product's advantage is trust between people, not payment technology.

---

# Part 20 — Final Verdict

**If Brohda disappeared tomorrow, what would users miss most?** The feed, and the specific feeling of being publicly, socially right about something in front of people who saw them call it.

**What feature deserves the most investment?** The identity/reputation layer. It's the biggest gap between what Brohda already does well and what it could be known for.

**What feature deserves the least?** The wallet's current multi-rail, form-heavy request flow — necessary in some form, but the version that exists today earns none of the investment it's currently absorbing.

**What feature should disappear next?** COMBO pools. No feature on the entire list is further from the product's identity or closer to zero real demand.

**What feature will matter ten years from now?** The feed, and whatever reputation system sits underneath it. Everything else in this product is implementation detail around those two things.

**What should become the heart of Brohda?** Being known. Not for winning the most money, not for entering the most pools — for being, provably, among the people who actually know the game. Every decision in this report points at the same target: strip away everything that isn't that, and build harder on everything that is.
