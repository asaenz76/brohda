# FOUNDER_IMPLEMENTATION_PLAN.md

**CPO decision memo. Beta → public launch.**

Four documents got us here: what Brohda is built from, what to cut, what to build in its place, and where it hesitates today. This document doesn't re-litigate any of that. It decides. Everything below is what we are doing, in what order, and why — treated as if Brohda is the only product I will work on for the next ten years, not a launch to hit and move on from.

---

## Product Identity

**Brohda is where football fans prove who knows the game best.**

Every decision in this document is graded against that sentence. If a recommendation doesn't make that sentence truer, faster to say, or easier to feel — it doesn't ship.

---

# Part 1 — Executive Summary

**The five biggest truths, across all four prior reports:**

1. **The core loop is already good. The surface around it isn't.** The feed, the pick, the confirm gesture, comments, follows — these work, emotionally and mechanically. Almost everything wrong with Brohda today is optionality and system-facing complexity that has grown up *around* that loop, not inside it.

2. **Every simplification we make is also an engagement win, because the thing crowding out the good stuff is the same thing causing the friction.** Six payment rails, four visibility states, five pool types — these are simultaneously the Simplicity Review's cut list and the UX Report's friction list. There is no tension here to resolve. Cutting is the engagement strategy.

3. **The product's biggest untapped asset is identity, not features.** Every report converges on the same observation from a different angle: users want to be *known* for something. The leaderboard gives rank. Nothing today gives *reputation* — a story about who you are as a predictor. That gap is this plan's single biggest opportunity, and it's addressed head-on in Part 4.

4. **Money is the least trustworthy-feeling part of a product whose entire value proposition is trust.** The wallet's silence — no stated timelines, no visible pending state, a request-and-wait model — is the single most consistent friction point identified across every report. It's also cheap to fix without touching the underlying manual-approval model at all.

5. **Brohda doesn't need new features. It needs its existing ideas taken more seriously.** The sentiment bar, the streak counter, the fee transparency, the comment thread — every one of these is a good idea currently under-designed relative to its potential. The instinct to reach for something new should be resisted until every existing idea has been pushed as far as it can go.

---

# Part 2 — The Product We Are Actually Building

Forget what exists. Here is what we're building, stated plainly.

**What it is:** a small, social, football-obsessed proving ground. You predict what's going to happen in matches that matter to you, you put a small, fixed, equal amount on the line, and the result becomes part of a permanent, social record of who was right — visible to the people whose opinion of your football knowledge you actually care about.

**What it is not:** a sportsbook. Not a place to manage risk, chase odds, or maximize expected value. Not a prediction market, where the point is aggregating a crowd's belief into a price. Not fantasy sports, where the point is a season-long roster you manage like a job. Brohda has no odds, no variable stakes, no long-term commitment required to participate in a single moment.

**Who it's for:** football fans who already argue about matches in a group chat, and who would rather that argument have a scoreboard than stay a feeling. Not casual sports dabblers looking for entertainment; not serious bettors looking for edge. People who are already emotionally invested in being right, and just don't currently have anywhere to prove it.

**Why it deserves to exist:** because "I called it" is currently a sentence that dies in a group chat, unrecorded, unranked, and forgotten by the next match day. Every other product adjacent to this space either strips out the money (making the stakes fake) or strips out the friendship (making the stakes cold). Nothing else combines real stakes with real relationships at this scale. That combination is the product.

---

# Part 3 — The Five Pillars

**1. The Feed.** *Why it exists:* it's the room everyone's arguing in. *Emotion:* curiosity, belonging. *Why users return:* because the conversation moves without them if they don't check in — the same reason anyone checks a group chat.

**2. Predictions.** *Why it exists:* it's the verb that turns an opinion into a fact-in-waiting. *Emotion:* anticipation. *Why users return:* an open prediction is an open loop — psychologically, it wants to be resolved, and the only way to resolve it is to come back.

**3. Community.** *Why it exists:* it's the difference between a bet and a story — nobody brags about a bet they placed alone. *Emotion:* belonging, banter. *Why users return:* because being seen making the call, and being seen being right, is worth more than the win itself.

**4. Reputation.** *Why it exists:* it's the thing that outlives any single match — the compounding record of who's actually good at this. *Emotion:* pride, and its inverse, motivation. *Why users return:* reputation, once it exists, has to be defended. Nobody logs off when their name is on the line.

**5. The Wallet.** *Why it exists:* it's what makes the stakes real instead of symbolic — real stakes are what make a correct call *mean* something. *Emotion:* should be confidence; today, too often, is caution. *Why users return:* not for its own sake — the wallet should never be a destination anyone opens for pleasure. It exists purely to make the other four pillars mean something, and it should be exactly as invisible as that job requires.

---

# Part 4 — Identity System

*The single biggest net-new decision in this plan. Not a badge system. Not achievements. Not cosmetics. An identity that emerges from what you actually predict, computed, never chosen, never bought.*

### The core mechanic

Every settled prediction is a data point. Over a rolling window (recent form matters more than ancient history — this is closer to "how you're playing right now" than "your career stats"), the system looks for the one thing a person does *distinctively better than the group average*, and gives it a name.

Not "you got 5 things right." A name. A sentence you could say out loud: **The Underdog Hunter. The Draw Specialist. The Giant Killer. The Comeback King. The Contrarian. The Streak Machine. The Clutch Predictor.**

These are examples, not a fixed list — the actual set of possible identities should be broad enough that most active predictors eventually earn one, but specific enough that earning one means something. A rough shape for how categories get defined: any measurable, football-native pattern (correctly backing the underdog, correctly calling a draw when the room didn't, correctly picking against the sentiment bar, correctly calling a match after being down, a live win streak, correctly calling the tightest/highest-stakes pools) is a legitimate candidate category. New categories can be added over time; none of them should ever be user-selectable.

### Why users would care

Because it's the difference between "I'm 12th on a leaderboard" and "I'm known as the Draw Specialist." A rank is a number. An identity is a *reputation* — the thing people actually bring up about you in conversation. This is not a hypothetical; it's the exact mechanism that makes a nickname in a real friend group stick, applied to a domain (football calls) where it's finally measurable.

### How identities evolve

Recomputed on a rolling basis, not fixed at the moment of first earning it. If your last dozen draw calls have been sharp, "Draw Specialist" is live. If your form cools, it fades — quietly, without punishment, the same way a hot streak in real sports eventually cools. This is closer to *form* than to a trophy case, and that distinction matters: a trophy case is a gambling-adjacent completionist mechanic (collect them all); form is a living, honest, and re-earnable thing, which keeps it interesting rather than making it a permanent status symbol someone can coast on forever.

### How they disappear

The same mechanism that creates an identity removes it: statistical distinctiveness. If your pattern regresses to the group average, the label simply isn't distinctive anymore, and it stops being shown. No announcement, no loss notification, no shame — it just quietly isn't true right now. This also means an identity can be *lost* to someone else in the group, which is its own kind of story (see Part 8).

### How they remain authentic

Three hard rules, non-negotiable: **(1) never user-selected** — you cannot claim a title, only earn one; **(2) never purchasable** — there is no version of this system where money buys a title, ever, under any circumstance; **(3) minimum sample size enforced** — a title only appears once there's enough real history behind it to be meaningful, so a lucky streak of two picks never gets rewarded with a permanent-feeling label. Authenticity here isn't a design nicety, it's the entire value of the system — the moment a title can be gamed or bought, it stops meaning anything, and the whole mechanic collapses.

### How they generate conversation, strengthen reputation, and create stories

An identity should be visible next to a name wherever a name already appears — on a profile, and ideally in the comment thread on a match that's directly relevant to it (the Derby Expert commenting on a derby match is a different, more interesting comment than an anonymous one). That visibility is what turns a private stat into a public reputation: the label isn't just information, it's an invitation — "prove it" or "not this time" written into the product itself, without a single new mechanic beyond showing the label in the right place. It's also, structurally, one of the best story-generators available (Part 8) — "the Draw Specialist just lost his crown" is a sentence people say to each other unprompted.

### Why this doesn't become a gimmick

Because it never asks anything of the user. There's no menu to open, no achievement list to complete, no notification demanding attention. It's a fact about you, surfaced where facts about you are already shown, earned by doing the one thing the whole product already asks you to do: predict, honestly, and be right more than the room. That's the test for every future addition to this system too — if it requires the user to *do* something beyond predicting in order to engage with their own identity, it's drifted into gamification and should be cut.

---

# Part 5 — Emotional Architecture

| Stage | Desired emotion | Current emotion | Gap | Recommended fix |
|---|---|---|---|---|
| Opening the app | Curiosity | Mostly matches | Small | Protect as-is |
| Scrolling | Curiosity, mild FOMO | Mostly matches | Small | Ensure social signals lead every card (already recommended, now finalized as policy — see Part 9) |
| Choosing a pool | Anticipation | Mostly matches | Small | Fewer pool types = faster arrival at this feeling |
| Predicting | Anticipation, commitment | Mostly matches | Small | Protect slide-to-confirm exactly as-is |
| Waiting | **Should be the best part of the whole app** | Currently undesigned — nothing happens here | **Largest gap in this table** | Use the existing comment thread as the natural home for pre-match anticipation; no new feature required, just make it the obvious next tap |
| Watching the match | Shared anticipation, tension | Undesigned | Large | Same fix — the comment thread under a live pool is where this should live |
| Winning | Pride, publicly | Quiet, private, transactional | **Second-largest gap** | Distinct visual/copy treatment (already flagged); now paired with the Identity System — a win that shifts someone's identity should say so |
| Losing | Mild sting, no shame | Mostly fine | Small | Keep it brief and human |
| Refund | Neutral, reassuring | Mostly fine post-cleanup | Small | One consistent sentence, always |
| Checking rankings | Pride or motivation | Diluted by decision gates | Medium | Hard default, per prior reports; now enhanced by identity labels sitting next to names |
| Closing the app | **Should feel like something is unfinished** | Currently feels final | **Third-largest gap** | An open prediction, a live streak, or a contested identity are all natural "come back for this" hooks already present in the data — surface one, quietly, as the last thing seen |

**The pattern:** the three biggest gaps — waiting, winning, and closing — are all the *emotional peaks and cliffhangers* of the experience, and they're currently the three most under-designed moments in the product. This is not a coincidence; it's exactly where a young product tends to under-invest, because none of these moments are "a screen" in the traditional sense — they're the connective tissue between screens, and connective tissue is easy to forget to design.

---

# Part 6 — Daily Habit Loop

*Using only what already exists. No new mechanics.*

**Why open in the morning:** because overnight, somewhere in your circle, someone made a pick, commented, or shifted a leaderboard position. The feed, checked once a day, is never the same feed twice — that's true today and needs no new feature, only the discipline (Part 9) to keep the feed worth reading even on a day you have no active pool.

**Why return after lunch:** because a prediction made this morning is still open, and an open prediction is an open loop. This is the existing anticipation window, currently undesigned (Part 5) — the fix isn't a new feature, it's making the existing comment thread genuinely worth checking mid-day.

**Why check before kickoff:** because the sentiment bar is about to lock, and that's the last chance to see (and comment on) who's with the room and who's against it. This moment already exists structurally; it just isn't currently treated as a moment.

**Why return after the match:** because the result is in, and results are the entire point — pride if you were right, a small sting if you weren't, and either way, a shift in the identity system that's worth seeing.

**Why return the next day:** because reputation compounds. A streak that continued, an identity that solidified or slipped, a friend's contrarian call that landed — none of this requires a push notification manufacturing urgency. It requires the product to be honest that something changed since you last looked, and the identity system plus streaks plus leaderboard movement already generate exactly that "something changed" signal without inventing anything new.

**The loop, stated simply:** trigger is always social (a friend's action, a match event, a status change), action is always predicting or reacting, reward is always reputation (never a bigger number, never a payout headline), investment is always the growing social record — comments, streaks, identity — that makes the next visit richer than the last. This is the whole loop. It does not need a sixth ingredient.

---

# Part 7 — Reputation System

**What people should become famous for:** being right, specifically and repeatedly, about a describable pattern — not "lucky," not "active," but *right in a way that has a name* (Part 4). Fame in Brohda should always be earned through the Identity System's authenticity rules, never through raw volume or spend.

**How reputation should spread:** through comments, through identity labels appearing next to names in exactly the contexts where they're relevant, and through the leaderboard — three surfaces that already exist, none of which need to be new. Reputation spreads exactly as fast as the product makes it *visible*, and visibility is a design decision (surfacing), not an engineering one.

**How reputation should decay:** the same rolling-window mechanism that grows an identity also lets it fade. Nothing about reputation in Brohda should be permanent — a permanent reputation stops being interesting, because it stops being *current*. The tension between "you were great last month" and "are you still great" is exactly what keeps reputation worth checking on.

**How people should defend it:** by continuing to predict well. There is no explicit "defend your title" mechanic to build — the defense is built into the rolling-window recomputation itself. Every new settled prediction is, structurally, a defense or a loss of whatever identity is currently held.

**How people should challenge it:** the same way, in reverse — every prediction anyone else makes in the same category is an implicit challenge to whoever currently holds that identity. No dueling UI is needed; the shared category and the shared feed already put two people's records in the same room.

**How reputation creates conversation:** every one of the mechanisms above is designed to produce exactly one output — a reason for someone to say something about someone else, in public, inside the product. That is the actual measure of success for this whole system: not engagement minutes, but sentences said about other people.

---

# Part 8 — Storytelling

*Every story Brohda should naturally create, and how the existing product surfaces it without new complexity.*

- **"Everyone picked Team A except Maria."** Already fully supported by the sentiment bar; the missing piece is simply making the *outcome* of a contrarian call — win or lose — a distinctly flagged moment when it settles, not a notification indistinguishable from any other.
- **"Carlos predicted three upsets."** This is exactly what the Underdog Hunter identity (Part 4) is built to notice and name, automatically, without Carlos or anyone else having to keep score by hand.
- **"John finally broke his losing streak."** Streaks already exist as a number; this story requires only that a streak's *end* — in either direction — is treated as a visible, nameable moment, the same way its continuation already is.
- **"Nobody believed Ana."** Same mechanism as Maria's story above — the sentiment bar is the product's built-in story generator for exactly this shape of moment, and it is currently under-leveraged.
- **"The whole group got it wrong."** A pool where the sentiment bar leaned heavily one way and the result went the other is, structurally, the single most interesting outcome the product can produce — collectively wrong is funnier and more discussion-worthy than individually wrong. This deserves to be recognized as a category of its own, not treated identically to any other settled pool.

**How the product amplifies these without new complexity:** every one of these stories is already latent in data the product has — the sentiment bar, the streak counter, the settlement result. The only work required is *recognition*, not construction: when a settled result matches one of these shapes, treat it with slightly more visual and copy weight than a routine settlement, the same way a headline gets a bigger font than a caption. Nothing here requires a new feature. It requires the product to notice its own best moments and say so.

---

# Part 9 — Simplicity Roadmap

*Final categorization. Building on, not repeating, the prior reports' exhaustive audits.*

| Item | Decision | Why | User impact | Effort | Priority |
|---|---|---|---|---|---|
| Feed, comments, likes, follows, streaks, sharing | **KEEP** | The proven core loop | — | — | — |
| Pool types (5 → 2) | **SIMPLIFY** | Removes the classification tax on every card read | High | Medium | P0 |
| Grading templates (17 → ~5) | **SIMPLIFY** | Same reasoning, applied to question variety | High | Medium | P0 |
| COMBO pools | **REMOVE** | The single most sportsbook-coded feature in the product; no identity value | Medium | Low | P0 |
| Bookmaker-odds recommendation engine | **REMOVE from any player-visible surface**, keep as an internal admin aid only | Never let odds-language reach a player | Medium | Low | P0 |
| Payment rails (6 → 1, with others available on request) | **SIMPLIFY** | Removes the wallet's single biggest decision | High | Low | P0 |
| Participation visibility (4 states) | **REMOVE**, default to visible | No discoverable value | Low | Trivial | P1 |
| Profile field visibility (3 toggles) | **MERGE** into one | Same idea, one decision instead of three | Low | Trivial | P1 |
| Per-follow email granularity | **MERGE** into one global setting | Same reasoning | Low | Trivial | P1 |
| Leaderboard scope × range (6 combos) | **SIMPLIFY** to one hard default, rest optional | Removes the pride moment's decision gate | High | Low | P0 |
| My-picks page | **MERGE** into Profile | Redundant navigation | Medium | Low | P1 |
| Fixture Archive page | **MERGE** into Fixtures as a filter | Same reasoning, admin-side | Low | Low | P2 |
| Player analytics dashboard | **MERGE** — fold win rate/streak into Profile, retire the rest | Wrong emotional register for the product | Medium | Low | P1 |
| Admin hierarchy tree | **REMOVE** | Solves an org problem that doesn't exist yet | None (admin-only) | Low | P1 |
| Provider status panel as a destination | **SIMPLIFY** to a small indicator; keep the underlying safety logic | Ops plumbing wearing a product screen's clothes | None (admin-only) | Low | P2 |
| Competition Workspace's 5 sub-tabs | **MERGE** to ~2 | Admin efficiency, indirectly speeds new pools reaching the feed | Low, indirect | Medium | P2 |
| Loading/skeleton states | **DEFER-turned-P0** — not a cut, an addition, but the single highest-leverage UX fix identified across all reports | Every screen transition | High | Low | P0 |
| Win-moment visual/copy weight | **RETHINK, ship distinctly** | The product's best emotional beat, currently under-dramatized | High | Low | P0 |
| Wallet pending-state messaging | **RETHINK, ship immediately** | The product's biggest trust gap | High | Low | P0 |
| Void-reason jargon audit | **RETHINK, close remaining gaps** | Protects trust at its most fragile moment | Medium | Low | P1 |
| Identity System (Part 4) | **NEW, but not a feature-count violation — an emergent layer over existing data** | The single biggest untapped engagement lever identified in this whole process | Highest available | Medium-High | P0, staged after the cuts above land |

**Read of this table as a whole:** nine of the highest-priority items are removals or simplifications; three are additions, and all three additions are either free (recognizing data the product already has) or a direct emotional payoff for cuts already made elsewhere. This is the proof, in table form, of this plan's central claim: simplicity and engagement were never competing goals here.

---

# Part 10 — Navigation

**Ideal navigation, decided:**

- **Bottom nav stays exactly as-is** (Home/Search/Create/Leaderboard/Profile) — already correct, already thumb-optimized, already minimal.
- **Wallet stays reachable from the header balance pill, from anywhere** — correct, don't change.
- **Activity (history + notifications) stays reachable from the header bell, from anywhere** — correct, but gets one addition: a first-use label so it's discoverable, not just conventionally guessed at.
- **My-picks disappears, merged into Profile.** One less destination, one less thing to remember the difference of.
- **Fixture detail is reconsidered as a section within Pool detail** rather than a separate screen, since its distinct purpose was never self-evident.
- **Player analytics disappears as a destination**; its two load-bearing numbers (win rate, streak) move to the top of Profile, where they belong next to the identity label.
- **Rules becomes a help sheet, not a full page** — accessible, not a destination that implies ongoing engagement.

**Why:** every merge or removal here follows the same rule — one idea, one place. The bottom nav's five items should remain the only things a user has to remember how to find; everything else should be reachable in context, not memorized as a separate destination.

---

# Part 11 — Information Hierarchy

*What each screen's single primary idea is, and what should be noticed first, second, third, and last.*

| Screen | Primary idea | 1st | 2nd | 3rd | Last |
|---|---|---|---|---|---|
| Feed | "Here's what your circle thinks is happening" | The person | The pick | The sentiment | Administrative metadata |
| Pool detail | "Decide, then commit" | The question | The payout | The sentiment/social proof | The rule/grading detail |
| Profile | "This is who they are as a predictor" | Identity label + win rate/streak | Recent picks | Bio/identity details | Settings |
| Wallet | "You're in control of your money" | Balance | One clear action (add/withdraw) | Recent activity | Rail selection, if ever needed |
| Leaderboard | "Where you stand, right now" | Your position, in your circle | The names around you | Identity labels next to names | Scope/range controls |
| Notifications/Activity | "Here's what happened while you were gone" | The most emotionally significant event (a win, a shift in identity) | Other social events | Money events | System/administrative events |

**The rule enforced across every row:** the primary idea is always a person or a feeling; the settings, controls, and administrative detail are always last, regardless of screen. This is the same principle from Part 9's card-hierarchy fix, applied to the entire product, not just the feed.

---

# Part 12 — Feed Evolution

*Every element, tested against five real products with strong opinions about their own feeds.*

- **Would Instagram ship this element?** The card layout, avatar-first hierarchy, and like/comment row — yes, unambiguously; this is already Instagram-grade. A rule pill competing visually with the question — no; Instagram would never let metadata outrank the content.
- **Would Reddit ship this?** The comment thread and mentions — yes, Reddit's entire value is exactly this kind of threaded, opinionated discussion. A four-state visibility setting nobody uses — no, Reddit ships almost nothing that isn't a lever people actually pull.
- **Would Letterboxd ship this?** The idea of a personal, earned identity built from a taste/judgment history (their equivalent: your favorite-films profile, your ratings history) — yes, this is precisely Letterboxd's core insight, and it's exactly what Part 4's Identity System borrows and adapts. A generic analytics dashboard — no, Letterboxd's version of "your stats" is always framed as identity, never as a spreadsheet.
- **Would Strava ship this?** The idea that behavior over time earns you a recognizable identity among people who know you (their equivalent: segment leaderboards among friends, "you just beat your own record") — yes, directly analogous to Part 4. A permanent, un-decaying badge collection — no, Strava's best mechanics are all *current form*, not lifetime trophy cases.
- **Would Chess.com ship this?** A rating that moves up and down based on real, recent performance against real opponents — yes, this is the closest existing analog to how identity/reputation should decay and re-earn in Part 7. A leaderboard fragmented across six scope/range combinations before showing you anything — no, Chess.com's rating is one number, always visible, always current.

**Conclusion:** every element that passes this five-product test is already either KEPT or newly designed in this plan (Part 4, Part 9). Every element that fails it is already scheduled for removal or simplification. This isn't a coincidence — it's confirmation that the direction set by the prior three reports and formalized here is the right one.

---

# Part 13 — What Makes Brohda Unique

| Compared to | What they own | What Brohda takes, and leaves behind |
|---|---|---|
| Sportsbooks | Odds, markets, variable stakes, anonymous scale | Takes: real stakes make the outcome matter. Leaves: odds, house edge, stranger-vs-stranger anonymity — all of it, entirely. |
| Prediction markets | Aggregated crowd pricing, financial instruments | Takes: nothing directly — the sentiment bar is a social signal, not a price. Leaves: the entire framing of prediction as a financial instrument. |
| Fantasy sports | Season-long commitment, roster management | Takes: nothing structurally — Brohda is deliberately per-match, not per-season. Leaves: the complexity and time commitment entirely. |
| Reddit | Threaded conversation at anonymous scale | Takes: the comment thread as the real engine of the product. Leaves: anonymity — Brohda's conversations are always with people you actually know. |
| Instagram | Personal identity, a feed, a social graph | Takes: the entire visual and interaction language of the feed. Leaves: pure self-expression with no objective outcome — Brohda's posts resolve to a fact. |
| Strava | Identity earned from behavior, visible to people who know you | Takes: the exact mechanic, adapted from athletic effort to predictive accuracy (Part 4). Leaves: nothing — this is the closest analog and the most directly borrowed idea, applied to a new domain. |
| Chess.com | A living, current, re-earned reputation number | Takes: the "current form, not lifetime trophy" philosophy for reputation and identity (Part 7). Leaves: the single-number simplicity — Brohda's version is a name, not a rating, because names are more social than numbers. |
| Letterboxd | Identity built from taste and judgment, shared with a community | Takes: the framing of "your history is your identity," not your stats being a separate dashboard. Leaves: subjectivity — Brohda's version of taste is objectively provable, right or wrong, which is what makes it worth staking something on. |

**The unique combination only Brohda owns:** real, equal, fixed stakes — among people who actually know each other — resolving to an objectively provable outcome — that compounds into a living, social, re-earned identity. No other product on this list combines all four of those properties. That combination is the thing to protect above every other decision in this document, forever.

---

# Part 14 — Product Constitution

*The Forever Principles, expanded into permanent doctrine. Every future feature request is measured against every line below.*

**1. Every PollPool has one entry fee, and money never buys a bigger victory.** Equal stakes are what make a correct call mean the same thing for everyone in the room. The moment stakes become unequal, "who knows the game best" stops being an honest question.

**2. One great prediction is worth more than ten mediocre ones.** Depth of feeling beats breadth of options, always. A product that offers fewer, better-considered choices will out-engage a product that offers more choices every time, because choice itself is a cost, not a feature.

**3. The feed always comes first.** Nothing — no settings screen, no dashboard, no wallet form — competes with the feed for the first five seconds of a session. If a new screen wants that position, the answer is no by default.

**4. People are more important than statistics.** A name and a face beat a percentage and a chart on every screen, every time. Identity (Part 4) exists specifically to keep this true even as the product's data gets richer — the data should always resolve into a person, never stand alone as a number.

**5. Emotion beats information.** When a screen must choose between showing more data or making someone feel something, it chooses the feeling. This is not anti-intellectual — it's a recognition that Brohda's entire value proposition is emotional (pride, belonging, being right) and information is only useful in service of that.

**6. Every screen earns its place.** If a screen can't be explained by the one-sentence identity, it doesn't get a spot in primary navigation — it gets merged, demoted, or cut.

**7. Every feature earns its complexity.** A new setting, pool type, or status must justify itself against the emotional value it adds, not the completeness it provides. Completeness is not a goal of this product; memorability is.

**8. Every interaction should create a story worth telling someone else.** The test for any new idea: would someone screenshot this, or say it out loud to a friend? If the honest answer is no, the idea needs to be reworked until it is.

**9. The reward is always reputation, never variable payout.** Brohda's loop runs on pride and being provably right, and it will never run on the mechanics of a slot machine. This line does not move, regardless of what growth metric it might improve.

**10. Simple products spread.** Every change that makes Brohda easier to explain in one sentence is worth more than any feature that makes it harder — this is true even when the feature is good, because distribution compounds and features don't.

**11. Identity is earned, never claimed.** No title, badge, or reputation marker is ever user-selected or purchasable. The moment a status can be gamed, it stops meaning anything, and every downstream benefit of the Identity System collapses with it.

**12. Reputation is current, not permanent.** Nothing in Brohda should reward someone forever for something they did once. Everything that confers status should be re-earnable, and losable, on an ongoing basis — this is what keeps checking in on your own standing, and everyone else's, worth doing.

**13. The product should always know what it doesn't need to say twice, and what it must never say in jargon.** Every player-facing sentence is measured against whether a stranger would understand it instantly. Backend concepts (statuses, versions, internal reasons) never reach a player-facing screen in their raw form.

**14. Silence is never acceptable where trust is at stake.** Anywhere a user could reasonably wonder "did that work," the product states the answer plainly. This applies permanently, to every future feature that touches money, predictions, or identity.

**15. Build for the friend group you already have, not the audience you might have someday.** Every feature is evaluated against whether it would make sense in a five-person invite-only circle before it's ever evaluated against how it scales to fifty thousand strangers.

---

# Part 15 — Founder Checklist

*Every new feature request runs this gauntlet before a single line of design or code exists. Any hard "no" ends the conversation regardless of how many other questions score well.*

**Hard gates — a single "no" here kills the idea outright:**
- [ ] Does this avoid introducing odds, spreads, or variable stakes? *(If no — reject, no exceptions.)*
- [ ] Does this avoid rewarding volume, spend, or time-in-app over being right? *(If no — reject, this is gambling psychology by another name.)*
- [ ] Can this be explained in the same breath as the one-sentence identity? *(If no — reject or redesign until it can.)*

**Scoring questions — weigh honestly, in this order:**
1. Does this make Brohda easier to explain, not harder?
2. Does this create conversation between real people, not just interaction with the system?
3. Does this strengthen someone's identity or reputation, rather than sitting beside it as an unrelated feature?
4. Does this create a story someone would tell a friend?
5. Would people genuinely miss it if it were removed six months from now?
6. Would someone screenshot the result of this feature?
7. Would this survive a Steve-Jobs-style 30% cut, or is it the kind of thing that gets cut in that exercise?
8. Would Instagram, Strava, or Chess.com ship something shaped like this — or would they consider it clutter?
9. Does this violate KISS in any way that isn't justified by a genuinely new emotional payoff?
10. Do we, honestly, believe users would *love* this — not tolerate it, not find it useful, but love it?

**The final question, asked last, every time:** should we build this? If the answer to every scoring question above is a confident yes, and both hard gates are clear — yes. If more than two scoring questions are a shrug rather than a yes — the idea isn't ready, and the right move is to simplify it further, not to build a weaker version of it anyway.

---

# Final Deliverable — The Ten Biggest Decisions Brohda Must Make Before Launch

*Ranked by impact, sequenced by dependency and effort. This is the actual punch list.*

**1. Fix the wallet's silence.** State explicit timelines, show a real pending state. *Impact: highest — this is the product's single biggest trust gap. Effort: low. Do this first — it's cheap, it's foundational to trust, and nothing else on this list matters if money doesn't feel safe.*

**2. Give the win moment real weight.** Distinct copy, distinct visual treatment, tied forward into the Identity System once it ships. *Impact: highest — this is the product's best emotional beat, currently wasted. Effort: low. Ship immediately alongside #1.*

**3. Cut pool types and templates (5→2, 17→~5) and remove COMBO pools.** *Impact: high — removes the single biggest source of cognitive load on every card read. Effort: medium. Do this early; every later decision (card hierarchy, question copy, the Identity System's categories) is cleaner once the underlying question types are simpler.*

**4. Collapse every unnecessary decision** (payment rails, participation visibility, profile-field toggles, per-follow granularity, leaderboard scope/range) **to smart defaults.** *Impact: high, cumulative. Effort: low, mostly configuration and copy. Batch this as one focused sprint — it's a large number of small, independent fixes.*

**5. Add loading/skeleton states to the feed and pool detail.** *Impact: high — the product's most-opened screens currently risk a blank first impression on any slow connection. Effort: low. Sequence alongside #4.*

**6. Reorder every screen's information hierarchy so people and feeling lead, mechanics and settings trail** (feed cards, Profile, Leaderboard). *Impact: high, compounding across every session. Effort: low — this is almost entirely a reordering exercise, not new construction. Do this once #3 has simplified what's being reordered.*

**7. Merge redundant screens** (My-picks into Profile, Fixture Archive into Fixtures, the analytics dashboard's top numbers into Profile). *Impact: medium — reduces navigational memory load. Effort: low-medium. Bundle with #6, since both are structural cleanup passes.*

**8. Design and ship the Identity System.** *Impact: the single highest-ceiling item on this list — this is the mechanic most likely to make Brohda genuinely unlike anything else in its category. Effort: medium-high, and deliberately sequenced after #3 and #6, since a clean, simplified prediction taxonomy makes the identity categories cleaner to define and the reordered screens give identity labels a well-designed place to live the moment they exist. Do not rush this — it's worth doing right the first time, since authenticity (Part 4) is the entire point.*

**9. Remove admin-only complexity that never touches the player experience** (admin hierarchy tree, provider-status panel as a screen, Competition Workspace's sub-tab sprawl). *Impact: low-to-none for players, meaningful for the team's own velocity — every one of the player-facing items above ships faster with less admin friction in the way. Effort: low. Do this in parallel with any of the above; it has no sequencing dependency on the rest of the list.*

**10. Publish this document's Constitution (Part 14) and Founder Checklist (Part 15) as living, referenced governance** — not a one-time report, a standing filter every future idea runs through. *Impact: the least glamorous item on this list and arguably the most important one long-term — every one of the first nine decisions eventually erodes without a standing mechanism to prevent the next round of well-intentioned complexity. Effort: trivial to write, ongoing discipline to actually use. Do this now, on day one of the beta, not after launch — a constitution adopted after the product has already drifted is a much harder sell than one adopted while the product is still small enough to hold the whole shape of it in one head.*

**Recommended execution order:** 1 and 2 immediately (cheap, foundational trust and emotion fixes) → 3 and 4 as one simplification sprint → 5, 6, and 7 as one structural cleanup pass, sequenced right after 3–4 land so there's less to reorder and merge → 8 as its own deliberate, unhurried effort once the product underneath it is simple enough to build identity categories on top of cleanly → 9 in parallel, whenever admin capacity allows, with no blocking dependency on anything else → 10 today, immediately, running underneath everything else on this list as the filter every one of these nine decisions was already run through to make this list in the first place.
