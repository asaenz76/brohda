# BROHDA_PRODUCT_REINVENTION.md

**Chief Product Officer memo. Not a code document. Not a cut list. A redesign.**

The Architecture Review told us what Brohda *is built from*. The Product Simplicity Review told us what Brohda should *stop carrying*. This document answers a different question: once the weight is gone, what makes people *run* toward what's left?

Simplicity and engagement are not a trade-off here. They're the same move, made twice. Every time we remove a decision, we free up a moment for a feeling. This document exists to make sure we spend every one of those freed-up moments on purpose.

---

## Guiding Philosophy

Brohda is not trying to become a sportsbook. Not a prediction market. Not fantasy sports.

**Brohda is a social platform where football fans prove who knows the game best.**

Read that sentence again: the object of the product is not the match, and it's not the money. The object is *proof* — a public, social, remembered record of who was right. Everything in this document optimizes for that one thing: making it easier, faster, and more satisfying to be provably right in front of people who matter to you.

## Core Question

For every feature in this document, one question is asked and answered: **does this make someone more excited to open Brohda tomorrow?** If the honest answer is no, the feature doesn't get a pass because it's well-built, because it's already shipped, or because it sounded good in a meeting. It gets rewritten, merged, or removed.

---

# Part 1 — The Emotional Experience of Brohda

*Walking through a real session, moment by moment, honestly.*

**Opening the app.** The feed loads. This is the first smile — a stories row of people you actually know, a scroll of real predictions with real stakes. This works today and should never be touched carelessly.

**Scrolling the feed.** Curiosity, mostly — "what did people pick," "is anyone going against the room." This is close to right. It becomes *nothing* the moment a card is dense with status labels, rule pills, and visibility metadata instead of a person's face and their pick.

**Deciding to enter a pool.** This should be anticipation — "am I right about this." Today it mostly is, right up until a template picker or a payout-math tooltip interrupts the instinct with arithmetic. The decision to predict should feel like an instinct, not a spreadsheet.

**The wallet.** This is where the product currently goes flat, and worse than flat — it goes cold. Filling out a payment-proof form and waiting on a human is the opposite of anticipation; it's a chore with a delay attached. This is the single biggest emotional dead zone in the app today.

**Waiting for a match.** This should be the best part of the whole product — real anticipation, the specific kind that comes from having skin in the game with people you know are watching too. Today, nothing in the product actively builds this feeling; it's left entirely to the match itself. This is unclaimed territory.

**The result lands — you were right.** This should be pride, loud and immediate. Today it's a notification and a wallet credit. Correct, but quiet. A moment this good should not read the same as a routine system message.

**The result lands — you were wrong.** This should sting a little (that's fine — it's what makes being right feel good) but never feel punitive or bureaucratic. A refund notification citing a void-reason code is the worst version of this moment; a plain "not this time" is the right one.

**Checking the leaderboard.** This should be pride or motivation, depending on where you land. Today it mostly works, held back only by too many ways to slice it (six scope/range combinations) diluting the one number that should matter most: *where do I stand with my people, right now.*

**Closing the app.** The honest test: does someone feel like something is *waiting* for them tomorrow? Today, mostly no — nothing in the product actively creates that feeling. This is the single biggest opportunity in this entire document, and it's addressed directly in Part 15.

---

# Part 2 — Feature Review, Through an Emotional Lens

*Classification: KEEP / SIMPLIFY / MERGE / REMOVE / RETHINK. For everything not simply KEPT, the emotional value that replaces it is stated explicitly — nothing is cut without something taking its place.*

| Feature | Emotion it creates today | Would people miss it / talk about it / share it? | Verdict | What replaces the removed complexity |
|---|---|---|---|---|
| Social pool feed | Curiosity, belonging | Miss it instantly; it *is* the app | **KEEP** | — |
| Entering a pool | Anticipation (when fast) | Would talk about a great pick, not the mechanic | **SIMPLIFY** | Fewer question types = the anticipation arrives faster, less arithmetic in the way |
| Comments + mentions | Belonging, banter | Would miss and talk about it — this is where "you owe me" lives | **KEEP** | — |
| Likes | Cheap affirmation | Wouldn't be missed individually, but the absence of *any* reaction would feel cold | **KEEP** | — |
| Avatar stack | Social proof, mild FOMO | Would notice its absence | **KEEP** | — |
| Sentiment bar | Curiosity ("am I with the room or against it") | Would talk about being a lone contrarian who called it right | **KEEP, reframe as a story generator** (see Part 6) | — |
| Sharing | Pride, external bragging | Would use it after a big win | **KEEP** | — |
| 5 pool types, 17 templates | Confusion, decision fatigue | Nobody would miss the ones they never use | **SIMPLIFY → 2 types, ~5 templates** | Faster path from "see a match" to "make a call" — the anticipation arrives sooner |
| COMBO pools | Sportsbook anxiety, not fun | Nobody would miss it | **REMOVE** | Replaced by simple side-by-side pools you can discuss together in comments — same social thrill, none of the parlay math |
| Recommendation engine (bookmaker odds) | Nothing — it's invisible admin tooling | Nobody would notice its removal | **RETHINK** — keep as an internal admin aid, never let it surface as "the odds say..." anywhere a player can see | Community sentiment already does this job, socially, better |
| Wallet: deposit/withdraw request flow | Friction, distrust | Would complain loudly if it got *worse*; wouldn't defend it as-is | **RETHINK** (see Part 9) | A faster, single-rail flow replaces friction with trust |
| 6 payment rails | Admin overhead, decision fatigue for depositing | Nobody would miss the five they don't use | **SIMPLIFY → 1–2** | Same trust, none of the choosing |
| Participation visibility (4 states) | Nothing — invisible to most users | Nobody would notice | **SIMPLIFY → 2** | — |
| Follows (user) | Belonging, identity | Would miss it — this is core | **KEEP** | — |
| Team/league follows + per-follow email toggles | Mild utility, mostly invisible | Wouldn't be missed as separate settings | **MERGE into one notification preference** | Same utility, zero settings screen |
| Streaks | Pride, momentum | Would absolutely talk about a 5-win streak | **KEEP, amplify** (see Part 6) | — |
| Leaderboard | Pride, competition | Would check it constantly if it were simpler | **SIMPLIFY → one primary view** | — |
| Player analytics dashboard | Nothing — feels like a bank statement | Nobody would miss the charts | **REMOVE**, fold win-rate + streak into Profile | Same self-insight, delivered as a headline number, not a dashboard |
| My-picks page | Nothing — redundant | Nobody would miss it as its own page | **MERGE into Profile** | — |
| Rules page | Utility, once | Wouldn't be missed as a full page | **SIMPLIFY → a help sheet** | — |
| Notifications (void-reason taxonomy) | Confusion, bureaucracy | Nobody would defend the current copy | **RETHINK — rewrite as 4 human outcomes** | Same information, said like a person, not a database |
| Admin hierarchy tree | Nothing (invisible to players) | Nobody outside the team would ever know | **REMOVE** | No replacement needed — this never created player-facing value |
| Provider status panel (as a screen) | Nothing | Nobody would miss the screen, only the safety behind it | **RETHINK — keep the safety logic, demote the screen to a small indicator** | — |
| Competition Workspace's 5 sub-tabs | Nothing (admin-only) | Admins would prefer fewer tabs, not more | **MERGE into ~2 tabs** | Faster admin work = faster new pools = more feed content, sooner |
| Fixture Archive (separate page) | Nothing | Nobody would miss the page, only the data | **MERGE into Fixtures as a filter** | — |

---

# Part 3 — Screen Review, For Emotion

*What each screen should make someone feel, whether it does, and how to get there without adding UI.*

**Feed.** Should feel like: walking into a room full of your friends mid-argument about the weekend's matches. Today: close. What distracts: any card that leans on status/visibility metadata instead of a face and a pick. **Simpler and more addictive, with zero new UI:** reorder card elements so the person and their pick are always the first thing the eye lands on, and everything administrative (rule pill, void status) is the last, smallest thing on the card — pure reordering, no new components.

**Pool detail.** Should feel like: anticipation building toward kickoff. Today: neutral — it's a static summary. **Without new UI:** let the *existing* avatar stack and comment count visibly grow as kickoff approaches (they already update; the fix is making that visible motion the visual focus of the screen, not a footnote).

**Wallet.** Should feel like: confidence. Today: bureaucracy. **Without new UI, just reordering and copy:** put the balance and "you're covered" framing first, the request form last, and cut every field that isn't strictly necessary to trust the deposit.

**Profile (own).** Should feel like: pride in a track record. Today: identity, mostly, without much pride attached. **Without new UI:** promote win rate and current streak to the top of the screen — they're already computed, they're just buried under a bio and settings today.

**Profile (others').** Should feel like: curiosity — "is this person actually good, or lucky." Today: similar to own profile, undifferentiated. **Without new UI:** the same reordering (record first) does double duty here — it turns a visit to a friend's profile into a moment of assessment ("okay, they've actually got receipts") rather than a static bio read.

**Leaderboard.** Should feel like: competitive pride. Today: fragmented across six view combinations. **Without new UI:** default hard to "your circle, right now" and let the scope/range picker exist only as a secondary control, not the first thing you have to decide.

**Notifications/Activity.** Should feel like: a friend telling you news. Today: a system telling you a database event occurred. **Without new UI:** rewrite copy only — no new screen, no new component, just human sentences.

**Admin screens (all of them).** Should feel like: efficient, confident control. Today: closer to enterprise SaaS. Not addressed further here — this document is about the emotional product, and admins aren't the audience for engagement design — but every minute saved in admin friction is a minute sooner a pool hits the feed, which *is* a player-facing outcome.

---

# Part 4 — Workflow Review

*Decisions, clicks, excitement, friction, and memorability — for the workflows that actually shape a day in Brohda.*

**Registration** — 1 decision (accept invite), low excitement, low friction. Fine. No redesign needed; this moment doesn't need to be memorable, it needs to be fast.

**Joining** (first real session) — currently: land in a feed of strangers-to-you until you follow people. **Redesign:** the very first screen after accepting an invite should default-follow the person who invited you and show *their* recent picks first — the first thing a new user sees should be a face they already trust, not an empty feed.

**Making a prediction** — 1 decision, 1 confirmation, low friction already. Excitement: currently moderate, capped by template complexity. **Redesign:** collapse to fewer pool types (per Part 2) so the decision is purely "who wins," not "who wins, in which of five formats."

**Watching a live match** — currently: nothing happens in-product. This is the single most under-designed workflow in Brohda, and it's the one with the most natural excitement already built into it by the match itself. **Redesign:** without adding a live-score feature (real complexity, real infra), the app can still *use* what it already has — surface the pool you entered, with its comment thread, as the obvious next tap the moment a match on your card kicks off. Let the existing comments feature carry live reactions; don't build a new "live" feature, just make the existing social layer the natural home for match-time chatter.

**Winning** — currently: a wallet credit and a notification. **Redesign:** this is the single best emotional beat in the entire product and it's currently the quietest. The notification copy should read like a friend, not a receipt — "You called it. +$12" beats "Settlement confirmed: SETTLED_WON."

**Losing** — currently: a notification, functionally identical in weight to winning. **Redesign:** it shouldn't be punishing, but it also shouldn't be *emotionally invisible* — a losing notification that at least acknowledges the miss ("So close — X won it 2-1") does more for next-time engagement than a flat status update, because it closes the loop on the anticipation that was built pre-match.

**Receiving a refund** — currently: a void-reason-coded notification. **Redesign:** one sentence, always the same shape: "This one didn't count — here's your money back." No further decisions, no jargon.

**Following friends** — 1 click, no friction. Fine as-is.

**Checking rankings** — currently: a decision-heavy screen (scope × range). **Redesign:** default to zero decisions — open the leaderboard and immediately see your circle's current standings, full stop. Additional views become optional, not required.

**Returning tomorrow** — currently: no explicit design at all; whatever brings someone back is incidental. This is the most important gap in the whole product and gets a full answer in Part 15.

---

# Part 5 — The Emotional Loop

*Trigger → Action → Reward → Investment — designed deliberately around social reputation, never around variable monetary reward. This is the line this document will not cross: Brohda's loop is a pride loop, not a gambling loop.*

**Trigger (today):** mostly external — a friend mentions a match, or someone happens to open the app. Weak and unowned.

**Trigger (should be):** a social one — "someone you follow just made a pick" or "the match you have a stake in just kicked off." Both of these already exist as data the product has; neither is currently used as a *trigger* to bring someone back.

**Action:** open the feed, see picks, make one. Already close to ideal — short, low-friction, and it should stay exactly that simple as the question-type sprawl gets cut down.

**Reward — and this is the part to get right:** the reward in Brohda's loop must be *being seen as right*, not *the payout amount*. A gambling loop rewards uncertainty and variable payout size; a pride loop rewards a public, permanent, social fact: you called it, in front of people who saw you call it. The product should lean entirely into the second kind. That means: the reward moment should always foreground the social record (your streak, your comment thread lighting up, your name on the leaderboard) and never foreground "how much did I win" as the headline.

**Investment:** comments, follows, and streaks are already investment — each one makes the next visit more valuable because there's more social fabric to check in on. This is Brohda's strongest asset and the thing worth protecting above all else in this document: **every recommendation here should deepen investment in relationships and reputation, never in balance or bet size.**

**Where the loop currently works:** trigger-to-action (the feed itself). **Where it breaks:** there's no engineered trigger to return, the reward is under-dramatized (a quiet notification instead of a public, social moment), and investment (streaks, standing) is buried rather than surfaced. **How to strengthen it, without adding gimmicks:** make the *existing* social data — a friend's new pick, a settled result, a streak update — the thing that pulls someone back, and let the win moment be as socially loud as the product already knows how to be for a comment or a like.

---

# Part 6 — Moments Worth Talking About

*These are the sentences a great social product makes people say. Every one below is graded on whether Brohda already earns it, should be designed to earn it, or should actively be prevented.*

| Moment | Exists today? | Verdict |
|---|---|---|
| "I called it." | Partially — a win is real, but the notification doesn't hand you the bragging line | **Should exist, fully.** The win notification and the settled card should be built to be screenshotted. |
| "I can't believe everyone picked the other side." | The sentiment bar makes this *visible*, but nothing celebrates it after the fact | **Should exist.** A contrarian correct call deserves a specific, distinct callout — this is the single best underused asset in the product (see Part 2's sentiment-bar reframe). |
| "I'm top of the leaderboard." | Exists, diluted by six view combinations | **Should exist, simplified.** One obvious leaderboard, one obvious moment of arriving at the top of it. |
| "You owe me." | Exists implicitly through comments | **Already works — protect it.** This is peer accountability, not gambling; it's the healthiest kind of stake there is. |
| "I've won five in a row." | The streak number exists but isn't surfaced as a moment | **Should exist as a real moment**, not just a stat on a profile — a streak milestone deserves to be seen by more than just the person who has it. |
| "I knew it." | Same as "I called it" | Fold into the same win-moment design. |

**Moments that should disappear:** any moment currently phrased as a system event rather than a human one — "Settlement confirmed," "Void reason: X," "Grading version 2 applied." None of these are moments anyone wants to talk about, and their current prominence in notification copy is actively displacing the moments that are.

---

# Part 7 — Protect the Feed

*Every element on a prediction card, judged against: does it help someone decide, spark conversation, create emotion, or slow down scrolling.*

| Card element | Helps decide? | Sparks conversation? | Creates emotion? | Slows scrolling? | Verdict |
|---|---|---|---|---|---|
| Creator's name + avatar | No | Yes | Yes (this is a person, not a system) | No | **Stay, promote to most prominent element** |
| Match identity (teams, badges) | Yes | Yes | Some | No | **Stay** |
| The question | Yes | Yes | Depends on phrasing | No | **Stay — but simpler question types make this faster to read** |
| Entry fee + potential payout | Yes | No | Mild (anticipation) | No | **Stay, but keep it a glance, not a calculation** |
| Community sentiment bar | Yes | **Yes, strongly** | Yes | No | **Stay, and lean into it harder** (Part 6) |
| Avatar stack (who entered) | Somewhat | Yes | Yes | No | **Stay** |
| Rule pill / grading label | No | No | No | Slightly | **Shrink to the smallest, least prominent element on the card** |
| Status notice (void/anomaly copy) | No | No | Negative if jargon-heavy | Yes, when it's long | **Rewrite short, keep rare** |
| Like/comment/share row | No | Yes | Yes | No | **Stay — this is the social proof-of-life of the card** |
| Visibility metadata (if it ever surfaced) | No | No | No | Yes | **Never show this on a card** |

**The test for anything new proposed for a card, forever:** if it doesn't help someone decide, spark a comment, or create a feeling — and it takes up even one line of vertical space — it doesn't belong on the card. The feed's entire competitive advantage is how fast it reads. Every element earns its place or it's gone.

---

# Part 8 — Social First

*Person-to-person, or person-to-system? Every feature, sorted honestly.*

**Strengthens person-to-person interaction:** the feed, comments, mentions, likes, follows, sharing, the sentiment bar (it's a proxy for "what do my friends think"), the leaderboard (it's explicitly about your circle), streaks when shown publicly, avatar stacks.

**Strengthens person-to-system interaction:** the wallet request flow, notification settings, participation visibility, payment rail configuration, template selection, analytics dashboards, void-reason taxonomy.

The pattern is exact and telling: **every feature that made the "KEEP" list in Part 2 is person-to-person. Every feature that made "SIMPLIFY," "MERGE," or "REMOVE" is person-to-system.** That's not a coincidence — it's the whole thesis of this document in one observation. Brohda's job is to get out of the way between people, not to give people more system to manage. Any future feature request should be run through exactly this test before anything else: **does this put two people in a conversation, or does it put one person in a settings menu?**

---

# Part 9 — Money

*Money supports the experience. It does not become the experience. Nothing here is about hiding numbers — transparency and trust are the same goal, approached from different directions.*

**Wallet.** Make the balance the loudest number on the screen — bigger than any button. Confidence starts with clearly seeing what you have.

**Deposits.** Cut to one primary rail (per the Simplicity Review) and reframe the request form around trust, not proof — fewer fields, plain language ("we'll confirm this within a few hours," said honestly and specifically, not left ambiguous). The waiting is fine if it's *expected*; it only feels bad when it's unexplained.

**Withdrawals.** Same principle — one rail, one form, one clear expectation of timing stated up front.

**Platform fee.** Already shown twice (on the card, and again in the settlement breakdown) — this is genuinely good and should not change. The one gap: restate it once more, briefly, at the actual moment of commitment (the entry-confirmation screen), so transparency isn't something you have to remember from a screen ago.

**Estimated payout.** Keep it visible, keep it simple — a single number, not a formula. The math (gross pool, fee, split) belongs in the post-settlement breakdown, where curiosity about "how was this calculated" is real; it doesn't belong at decision time, where it's just friction between a person and their instinct.

**Refunds.** As covered in Part 4 — one sentence, one shape, every time, regardless of the twelve reasons behind it.

**How money becomes less intimidating without hiding anything:** the fix isn't obscuring numbers, it's changing which numbers are loud. A balance and a potential payout are exciting numbers. A fee percentage, a payment rail, and a transaction reference field are administrative numbers. Put the exciting ones first, always, and let the administrative ones exist exactly once, exactly where they're needed, and nowhere else.

---

# Part 10 — What Would Instagram Do?

*Kevin Systrom reviews Brohda today. He can only remove, merge, rename, reorder, and simplify — no new features allowed.*

"I'd start with names. 'Participation visibility' is a database column pretending to be a feature name — nobody should ever read that phrase. Rename everything so a setting's name is the plain sentence a user would say out loud ('Show who's picked what' instead of four enum values).

I'd merge the six leaderboard combinations down to one screen with a single, obvious default, and let the rest be a secondary tap, not a decision gate.

I'd reorder every card so the person is above the mechanics — right now the eye has to work to find the human in some of these screens, and on a feed, the human should always win that fight instantly.

I'd remove the analytics dashboard as its own destination — fold the two numbers anyone actually cares about (win rate, streak) into the profile header, where they already belong next to the person they describe.

I'd simplify the wallet from a form into a single number and a single button. If depositing $20 requires more taps than posting a photo, that's the whole problem, right there, in one sentence.

I would not add a single new feature. Everything Brohda needs to be unforgettable is already sitting in the product today, underused, or buried under a setting nobody asked for."

---

# Part 11 — The Steve Jobs Exercise: Remove 30%

*Not 10%. Thirty. Launching tomorrow.*

**What disappears:**
- COMBO pools, and 12 of the 17 grading templates (keep ~5)
- WHO_WILL_ADVANCE as a distinct pool type (fold into the same flow with a "no draw" flag)
- The bookmaker-odds recommendation engine's visibility to anything player-facing
- 5 of 6 payment rails
- Participation visibility's 4 states → 2
- Team/league follows' separate email toggles → 1 global preference
- The player analytics dashboard as a destination
- My-picks and Fixture-Archive as standalone pages
- The admin hierarchy tree
- The provider-status panel as a navigable screen
- 4 of 5 Competition Workspace sub-tabs
- The full void-reason taxonomy as player-facing copy (keep it internally, expose 4 outcomes)

**Why:** every item on this list is either system-facing complexity a player never needed to see, or optionality that fragments a decision that should be instant. None of it is where anyone smiles, hesitates meaningfully, or feels pride.

**How the remaining 70% gets stronger:** every one of these removals hands time and attention back to the five things people already love — the feed, the pick, the wallet, the standing, the result. A product that does five things at full emotional volume beats a product that does twenty things at a whisper. This isn't a smaller Brohda. It's a louder one.

---

# Part 12 — The Founder Trap

*Built because it sounded like a good idea, not because users loved it:*

- **COMBO pools** — imported a sportsbook pattern wholesale, never asked whether friends actually want to reason about parlays together.
- **The bookmaker-odds recommendation engine** — solved "which question is statistically interesting" instead of "which question would my friends argue about."
- **The admin hierarchy tree** — built org-chart infrastructure before there was an org to chart.
- **17 grading templates** — completeness for its own sake; nobody asked for a market on cards issued after minute 60.
- **Four participation-visibility states** — solved a hypothetical about *when* sentiment should be revealed, when the actual answer is almost always "show it, it's the fun part."
- **The player analytics dashboard** — built because the numbers were already computable, not because a casual predictor asked for a monthly-activity chart.
- **Per-follow email granularity** — solved a level of control nobody was asking to have, at the cost of a settings screen nobody wanted to visit.

The tell, every time: each of these solves a *system* problem elegantly while solving zero *emotional* problem. That's the trap, and it's the exact filter this whole document exists to apply going forward.

---

# Part 13 — Future Bloat: The Next 20 Feature Requests

*What a founder is likely to ask for next, evaluated honestly, before any of it gets built.*

| Likely request | Strengthens or dilutes the identity | Verdict |
|---|---|---|
| In-app group chat / DMs | Dilutes — comments already carry the social weight; a messenger is a different product | **No** |
| Push notifications for every micro-event | Dilutes — turns anticipation into spam | **No** |
| Referral rewards / invite bonuses | Neutral-to-dilutes — pays people to invite instead of letting the product earn the invite | **No, at least not as a paid incentive** |
| Achievement badges beyond streaks | Dilutes — gamification creep with no natural stopping point | **No** |
| Seasons / tournaments with prizes | **Could strengthen** — a season is just "the leaderboard, with a start and an end," which sharpens pride without adding a system | **Maybe, if it's a leaderboard reset, not a new economy** |
| In-app currency / cosmetic shop | Dilutes — introduces a second economy that competes with the one that matters | **No** |
| Verified / Pro accounts | Dilutes — creates tiers in a product whose principle is equal competition | **No** |
| AI prediction assistant / auto-picks | Dilutes — the entire point is a *human* proving they know the game; an AI pick is the opposite of the product | **No** |
| Cash-out / prediction insurance | Dilutes strongly — this is a sportsbook mechanic, full stop | **Absolutely not** |
| Multi-sport expansion | Dilutes, for now — football-first means football-only until football is fully loved | **Not yet** |
| Embedded video highlights | Neutral — nice-to-have, not identity-defining, real licensing complexity for little emotional gain | **No, not worth the cost** |
| Weekly recap ("your week in Brohda") | **Strengthens** — this is pure pride and shareability, built entirely from data the product already has | **Yes, eventually — but as a moment, not a new screen** |
| In-feed sponsorships / ads | Dilutes badly — undermines trust in a product whose whole pitch is transparency | **No** |
| Gift an entry to a friend | **Could strengthen** — it's a social gesture, not a system feature, if kept extremely simple | **Maybe, later, only if it stays a single tap** |
| Celebrity/influencer guest predictors | Dilutes — brings strangers into a product about people you actually know | **No** |
| Live odds movement display | Dilutes strongly — this is literally sportsbook UI | **Absolutely not** |
| Trophy case / collectible items | Dilutes — solves a problem (permanence of pride) that a well-designed profile already solves for free | **No** |
| Private mini-leagues (beyond friend groups) | **Could strengthen** — this is just "more than one leaderboard scope," already close to something the product understands | **Maybe, later, if it stays a simple grouping, not a new system** |
| Confidence-weighted / prediction-market pricing | Dilutes strongly — turns a fixed, equal-competition entry fee into a variable-stakes instrument | **Absolutely not** |
| Public global leaderboard across all users | Dilutes — pits strangers against each other for meaningless bragging rights | **No** |

**The pattern across all twenty:** every "yes, maybe" is something that deepens the *existing* social/pride loop with almost no new system. Every "no" adds a system — money, tiers, AI, ads, strangers, variable stakes — that competes with the one loop Brohda has already earned the right to own.

---

# Part 14 — The One-Minute Test

*Can a stranger understand Brohda in sixty seconds? Rewriting every version of the pitch until they all tell the same story.*

**One-sentence pitch:** "Brohda is where you prove you know football better than your friends do."

**Friend-at-a-bar explanation:** "You know how everyone in the group chat has an opinion about every match? Brohda's where you actually put your name on it — small bet, whoever's right gets bragging rights and the pot. It's basically Instagram for calling your shots."

**Tagline:** "Prove it."

**App Store description (short):** "Brohda is the social home for football predictions. Follow your friends, call the match, and find out — publicly — who actually knows the game. Fixed entry fee, no odds, no sportsbook. Just you, your circle, and the scoreboard."

**Homepage headline:** "Everyone's got an opinion about the match. Brohda is where you find out who's right."

**Investor pitch:** "Brohda turns the group chat's endless football debate into a real, social, low-stakes competition — a leaderboard for who actually knows the game, built on a feed people check every day because their friends' reputations, not just their money, are on the line."

**Do they tell the same story?** Yes — every version leads with *proving something, socially, about football, with people you know.* None of them mention pool types, wallets, or admin tooling, because none of that is the story. If any future pitch, screen, or feature can't be summarized by this same sentence, that's the signal something has drifted, not a reason to write a longer sentence.

---

# Part 15 — The Daily Open Test

*No money in the wallet. No active pools. Nothing to win today. Why open Brohda?*

The honest current answer is: there isn't one. That's the single most important finding in this entire document.

**The better answer, without gimmicks:** you open Brohda because *your people* are there, being interesting, right now — not because there's a prize waiting for you. The feed itself, done right, is the reason: seeing who's picking what on today's matches, seeing a friend on a streak, seeing someone about to go against the room. None of that requires you to have a dollar in play. It only requires the feed to be worth reading on its own, the way a good group chat is worth checking even on a day you have nothing to say.

**Concretely, without adding a single gimmick:**
- The feed should always be interesting to *watch*, not just to *play* — every pick anyone in your circle makes is content, whether or not you have money on the same match.
- Streaks and standings should be visible enough that checking in on a friend's hot streak is, by itself, a reason to open the app.
- A settled result from yesterday — a friend's win, a contrarian call that paid off — should still be worth seeing today, because the story of it (the comment thread, the reactions) doesn't end the moment the match does.

The right design goal here is not "give people a reason shaped like a reward." It's "make the *people* the reason" — because that's the one hook that never needs a gimmick, never triggers a gambling instinct, and never runs out.

---

# Part 16 — The Forever Principles

These ten do not change with the roadmap. Every future feature, screen, or decision is measured against them before anything else.

1. **Every PollPool has one entry fee — money never buys a bigger victory or an advantage over anyone else.**
2. **One great prediction is worth more than ten mediocre ones — depth of engagement beats volume of features.**
3. **The feed always comes first — nothing competes with it for the first five seconds of a session.**
4. **People are more important than statistics — a name and a face beat a percentage and a chart, every time, on every screen.**
5. **Emotion beats information — if a screen has to choose between showing more data or making someone feel something, it chooses the feeling.**
6. **Every screen earns its place — if it can't be explained by the one-sentence pitch, it doesn't belong in the primary navigation.**
7. **Every feature earns its complexity — a new setting, a new pool type, a new status must justify itself against the emotional value it adds, not the completeness it provides.**
8. **Every interaction should create a story worth telling someone else — the test for any new idea is "would someone screenshot this."**
9. **The reward is always reputation, never variable payout — Brohda's loop runs on pride and being provably right, and it will never run on the mechanics of a slot machine.**
10. **Simple products spread — every removal that makes Brohda easier to explain in one sentence is worth more than any feature that makes it harder.**

These are not aspirational. They are the filter. The next feature request — whatever it is — gets tested against these ten before it gets tested against anything else, including whether it's technically easy to build.
