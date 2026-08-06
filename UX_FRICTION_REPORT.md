# UX_FRICTION_REPORT.md

**A usability audit of Brohda, conducted as if observing a moderated usability study before public launch.**

This document does not propose features. It hunts for friction — every hesitation, every unnecessary tap, every sentence that requires a second read, every moment a user might quietly wonder "did that work?" The standard is not "is this broken." The standard is "does this cost a fraction of a second of confidence, and could that fraction be given back."

**Guiding principles this report is judged against:** Instant. Social. Effortless. Transparent. Fair. Mobile-first. Any hesitation is a bug. Any sentence that needs explaining is a bug. Any forced decision is a candidate for deletion, not just simplification.

---

# Part 1 — First Impression Test

*A first-time user, invited by a friend, opens Brohda for the first time. Documenting the first 60 seconds honestly.*

**0–5 seconds:** The feed loads. First thought: "okay, this is a feed — like Instagram." Card layout, avatars, a stories row up top — the visual grammar is immediately, correctly familiar. This is the strongest possible first five seconds a product like this could have.

**5–15 seconds:** First card is read. A person's name, a match, a question, some percentages, two or three buttons, an entry fee. First hesitation arrives here: **is this a bet?** The presence of a dollar amount next to a football match, before any social content has been read, is the single most consequential piece of information on the screen — it decides which mental model the user reaches for next (sportsbook vs. game with friends), and right now it arrives *before* the social framing does.

**15–30 seconds:** The user notices comments and likes on the card, or scrolls to a card with visible activity. **This is the moment the correct mental model clicks into place.** Social proof — a friend's name attached to a pick, a comment thread — is what disambiguates "betting app" from "social app with a betting mechanic." Until that moment arrives, the honest, first-principles read of the screen is ambiguous between sportsbook and social network.

**30–60 seconds:** The user probably taps into a card to see more, or opens a profile. By now the mental model should be settling into "this is a game I play with people I know," assuming a social element was visible in the first screenful of the feed.

**Would a new user think this is a sportsbook, a social network, fantasy sports, or a prediction market?** Honestly: **their very first instinct, before any social content registers, leans sportsbook** — a dollar figure next to a match result is that category's signature visual pattern, and it's simply faster to recognize than "these are my friends." The product recovers within the same minute, but it recovers *because of content that happens to be on screen*, not because the interface itself declares its category unambiguously from the first pixel.

**If understanding takes longer than one minute, why:** it doesn't take longer than a minute in the best case (a feed full of active social cards). It risks taking longer in the worst case — a quiet moment in the feed, a card with no comments yet, no visible community activity — where nothing but the dollar amount and a football match is available to form a first impression from.

**The fix costs nothing to build:** it's a matter of what's guaranteed to be visible in the first screenful, not a new feature — make sure the very first card a new user ever sees is guaranteed to carry a visible social signal (a comment, a friend's avatar stack, a "your inviter picked this") rather than leaving that to chance.

---

# Part 2 — The Three-Second Rule

*Can a user understand each screen's purpose in three seconds? If not, what's distracting from the one thing that screen is for.*

| Screen | 3-second pass? | What distracts |
|---|---|---|
| Feed | Yes | — |
| Pool detail | Mostly | Rule-pill/status-notice text competes with the question and the pick buttons for the first glance |
| Fixture detail | **No** | It's not obvious at a glance how this differs from Pool detail — two screens answering a similar-looking question |
| Wallet | Partial | The balance is instantly clear; the deposit/withdraw *form*, once opened, is not a 3-second screen — it's a form, and forms are never 3-second screens by nature |
| Activity | Yes | — |
| Profile (own) | Partial | Bio/pronoun/gender fields and their individual visibility toggles compete visually with the one thing a profile should communicate fastest: win rate and streak |
| Profile (others') | Partial | Same issue |
| Followers/Following | Yes | — |
| Leaderboard | **No** | Two controls (scope, range) must be parsed before the ranking itself can be read — the *ranking* should be the 3-second payoff, not a decision gate in front of it |
| My-picks | **No** | Its purpose relative to Profile's own predictions view isn't self-evident without prior context |
| Analytics (player) | **No** | Multiple charts and filters — this is a "sit and read" screen, not a "glance and know" screen, on a product whose every other surface is built for glancing |
| Search | Yes | — |
| Rules | Partial | Depends entirely on length; if it's more than a screenful, it's already failed the standard this product holds everything else to |
| Login/Register/Reset | Yes | — |

**Pattern:** every screen that fails the 3-second test fails for the same underlying reason — it presents a *decision* (which range, which scope, which tab) before it presents the *payoff* the user actually came for.

---

# Part 3 — Navigation Friction

*Real tap counts, based on the product's actual information architecture (a 5-item bottom nav — Home, Search, Create, Leaderboard, Profile — plus a header wallet pill and notification bell always visible).*

| Task | Taps | Notes |
|---|---|---|
| Find a PollPool | 0 | It's the home screen — correctly, the lowest-friction path in the whole product |
| Join a PollPool | 2 (pick option → confirm) | Already close to minimal |
| See results | 1 (open the pool, or read the notification directly) | Fine |
| Check wallet | 1 (header balance pill, from anywhere) | Good — this is exactly right |
| Find a friend | 1 + typing | Fine |
| Comment | 2 (open sheet → type) | Fine |
| Reply | 3 (open sheet → tap reply → type) | One tap more than a top-level comment — acceptable, replies are naturally a deeper action |
| View profile | 1 (tap a name/avatar) | Fine |
| Follow someone | 2 (open their profile → tap follow) | **Could be 1** — a follow button directly on a comment or an avatar-stack entry would remove the detour through a full profile page for the single most common social action in the product |
| See leaderboard | 1 (bottom nav) | Good |
| See history | 1 (header bell → Activity) | Good, but **only if the user already knows the bell icon leads there** — "Activity" as a destination isn't self-labeled anywhere in the primary navigation, only reachable via an icon that's conventionally understood as "notifications," not "your full history." This is a discoverability gap disguised as a low tap-count. |

**The one real structural finding here:** tap counts are almost uniformly excellent — this is a well-architected information hierarchy. The friction that remains is not about *distance*, it's about *discoverability* (does the user know where to tap) and *unnecessary intermediate screens* (Follow requiring a full profile visit).

---

# Part 4 — Decision Friction

*Every decision a user is asked to make, and whether the system should just decide instead.*

| Decision | Should the system decide? | Smart default | Would removing it improve things? |
|---|---|---|---|
| Choose a payment method (of 6) | **Yes** | One primary rail, offered by default; alternates available but never presented as a peer choice | Yes — every rail removed from the *decision* (even if kept available on request) shortens the single most anxious moment in the product |
| Choose pool participation visibility (4 states) | **Yes** | Default to "visible" always — sentiment is the fun part | Yes — this setting has no discoverable value to the person choosing it |
| Choose leaderboard scope + range (6 combos) | **Yes** | Default to "your circle, all-time," full stop | Yes — directly fixes Part 2's leaderboard finding |
| Choose notification settings, per team-follow and per league-follow | **Yes** | One global on/off | Yes — nobody wants to manage this at the granularity it currently offers |
| Choose profile field visibility (3 separate toggles) | **Yes** | One "show extra info" toggle | Yes — three decisions standing in for one |
| Choose which pool type to enter (implicitly, by reading which of 5 types a card is) | **Yes, upstream** — this is a creation-time decision leaking into the entering experience | Fewer pool types at the source means less type-recognition work at read time | Yes — a player shouldn't need to mentally classify what kind of question they're looking at before answering it |
| Decide whether to read the rule pill before predicting | Effectively forced today, since the grading logic isn't always self-evident from the question text alone | Write every question so the rule is obvious from the sentence itself, making the rule pill a confirmation, not a requirement | Yes — this is real decision friction disguised as a label |

**The general pattern:** almost every optional setting in Brohda currently defaults to "ask the user," when the honest answer for nearly all of them is "the system already knows the right answer, and asking just spends the user's attention for no benefit."

---

# Part 5 — Cognitive Load

| Source of load | Why it costs attention | How to simplify |
|---|---|---|
| Pool-type vocabulary ("Who will advance?" vs. a regulation-result question vs. a binary prop) | A user has to silently classify *which kind* of question they're reading before they can answer it | Collapse to fewer types so the classification step disappears |
| Rule pill / grading-rule label | A second read is required to confirm the question means what it appears to mean | Write self-explanatory questions; keep the label as a footnote, not a requirement |
| Multiple dollar figures on one card (entry fee, potential payout, platform fee) | Three numbers competing for attention where one (the payout) is what actually matters at decision time | Lead with the payout; keep fee/entry-fee as secondary, smaller text |
| Void-reason-flavored copy anywhere it's still database-literal | Jargon forces a re-read and, worse, an unanswered "what does that mean" | Collapse to the small, human vocabulary already established in Part 6 of the prior reviews (won / lost / refunded / pending) |
| Leaderboard's scope × range matrix | Two independent decisions before one payoff | Default hard, hide the matrix behind a secondary tap |
| Participation-visibility / profile-visibility settings | Options with no discoverable purpose still have to be silently evaluated ("do I need to change this?") every time they're encountered | Remove the choice; keep the good default |
| Icon-only affordances without a label the first time they're seen | An unlabeled icon requires a guess or a tap-to-discover | Label icons on first encounter; icon-only is fine once the pattern is learned, not before |
| Multiple similar screens (My-picks vs. Profile predictions tab; Fixture detail vs. Pool detail) | The user has to remember which screen has which information, which is a memory tax repeated on every visit | Merge them; one canonical place per idea |

---

# Part 6 — Feed Review

*Every element on a prediction card, judged for usefulness, speed cost, and whether it's actually read.*

| Element | Helps decide? | Slows scanning? | Actually read? | Verdict |
|---|---|---|---|---|
| Creator avatar + name | No (doesn't affect the prediction itself) | No | **Yes, first** | Keep, keep first |
| "Posted Xh ago" | No | Minimal | Rarely | Keep small, low-priority |
| Public/Private pill | No | Slight | Rarely, unless private | Keep, but shrink |
| Match identity (badges + names) | Yes | No | Yes | Keep |
| The question | Yes | No | Yes | Keep, but shorten where pool-type complexity currently lengthens it |
| Community sentiment bar | Yes | No | **Yes — this is a high-attention element** | Keep, promote |
| Option buttons | Yes | No | Yes | Keep |
| Entry fee | Yes, marginally | No | Glanced at | Keep, small |
| Potential payout | Yes | No | **Yes — probably the second-most-read number after the question itself** | Keep, promote to more visual weight than entry fee |
| Rule pill | Only when the question is ambiguous, which shouldn't happen | Slight | Rarely, unless confused | Shrink further; treat its necessity as a signal the question copy needs work |
| Avatar stack (who's in) | Yes (social proof) | No | Yes | Keep |
| Like/comment/share row + counts | No (doesn't affect the prediction) | No | **Yes, constantly** | Keep — this is the highest-engagement row on the card |
| Status notice (void/anomaly copy) | No | **Yes, when verbose** | Only on affected pools | Rewrite short; today's version, when it appears, is the single slowest-reading element on any card |

**Can two elements become one?** "Posted Xh ago" and the Public/Private pill are both low-value metadata that could combine into one small line rather than two separate visual chips competing for the same sliver of attention.

**Scan time for one healthy card, today:** roughly 2–3 seconds to register creator, match, question, and sentiment — which is good. It degrades toward 4–5 seconds on any card carrying a status notice or an unusually long templated question, which is exactly where the friction budget should be tightest, not loosest.

---

# Part 7 — Prediction Flow

*The complete journey, moment by moment, watching for where attention breaks, confidence drops, excitement rises, or someone would quit.*

**Open feed → excitement is already present** (a live social feed, low effort, high curiosity). This is the strongest moment in the entire flow and it costs nothing — it's just the feed doing its job.

**Choose a PollPool → excitement holds, mild decision cost** as the user compares a few cards' sentiment bars and payouts. Healthy — this is the "which game do I want to play" moment and a small amount of deliberation here is a feature, not a bug.

**Read the card → this is where the first small confidence dip can occur**, specifically on any card whose question needs the rule pill to fully parse, or whose type is unfamiliar (a combo, a knockout-advance question). A user who has to *work* to understand what they're predicting loses a measurable amount of the excitement they arrived with.

**Understand the rules → the biggest single risk point for quiet abandonment.** If a question requires real interpretation, a user with even mild uncertainty is statistically more likely to scroll past than to ask a clarifying question in the comments. This is invisible churn — it doesn't look like a bug report, it looks like nothing happening.

**Make a prediction → excitement returns**, assuming the previous step didn't cause a silent exit. The tap-to-select interaction itself is fast and satisfying.

**Confirm → the slide-to-confirm gesture is a genuinely good, deliberate-feeling moment** — weighty without being slow. This is one of the strongest micro-interactions in the product and should not be touched.

**Return to feed → confidence should be at its peak here** ("I did it, I'm in") but nothing currently *marks* that peak distinctly — the user just lands back on the same feed they left, with no visible acknowledgment beyond whatever passive state change happened on the card. **This is a missed opportunity, not a broken step** — the single highest-confidence moment in the entire flow currently looks identical to just scrolling.

**Where would users abandon, honestly?** Almost never during entry itself — the mechanics are fast and well-built. The real abandonment risk is *earlier and quieter*: scrolling past a card whose question required a beat too long to parse, well before the "make a prediction" tap is ever attempted. That's a comprehension problem, not an interaction problem, and it won't show up in any funnel analytics that only measure taps.

---

# Part 8 — Wallet Experience

**Where users lose confidence:** the instant they leave the balance pill and enter the deposit form. The balance itself is a source of confidence (it's a clean, honest number); the *path to changing it* is where confidence drops.

**Where they hesitate:** choosing among six payment rails when they don't have a strong existing preference; filling in a "transaction reference" field without being told exactly what counts as valid proof; submitting and then not knowing how long "pending" actually means.

**What creates anxiety:** the gap between "I sent money" and "my balance updated" is currently unbounded from the user's point of view — no stated expectation, no visible progress state beyond a generic pending status. Anxiety in a wallet flow is almost always a *silence* problem, not a *speed* problem — people can tolerate a wait; they can't tolerate not knowing whether the wait is normal.

**What creates trust:** the fee is shown twice (upfront on the card, again in the settlement breakdown) — this is a genuine, working trust signal and should be protected. The transaction detail sheet's full breakdown (gross pool, fee, net, payout) is exactly the right level of transparency, delivered exactly where curiosity about it naturally occurs — after the fact, not before.

**What information is missing:** an explicit, stated expectation for how long a deposit/withdrawal request typically takes to review. Silence is being read as risk; a plain sentence ("usually reviewed within a few hours") converts the same wait into a known, bounded, low-anxiety fact.

**What information is unnecessary:** the six-rail choice itself, and any field asking a user to describe *how* they paid beyond what's strictly needed to verify it — every extra field between "I want to add money" and "it's confirmed" is a place attention leaks out of the flow.

---

# Part 9 — Social Friction

**Encourages conversation:** comments with @mentions, visible like counts, the avatar stack showing who else is in — all already good, all already working exactly as intended.

**Discourages conversation:** any card where the social elements (comments, avatar stack) are visually subordinate to administrative elements (rule pill, status notice, visibility pill) — the eye has to work past the "boring" parts to reach the "social" parts, which is backwards for a product whose whole identity is social-first.

**Feels mechanical:** notification copy that leaks database language; the void-reason-driven status notices; anything phrased as a system confirmation rather than a human statement.

**Feels human:** comments themselves; the follow/unfollow toggle's immediate, no-friction response; the slide-to-confirm gesture's tactile weight.

**What would make someone interact more, without adding a single feature:** reordering, not adding. Put the person and the social proof first on every surface, every time, and let the mechanics of the prediction be the quiet supporting detail rather than the headline. A feed that visually leads with people, not markets, is a feed people talk in, not just at.

---

# Part 10 — Emotional Friction

| Screen | Intended emotion | Actual emotion today | Gap, and why |
|---|---|---|---|
| Feed | Curiosity, belonging | Mostly matches | Occasional dilution when administrative card elements crowd the social ones |
| Prediction (entry) | Anticipation | Mostly matches, dips on unclear questions | Rule-pill dependency is the main leak |
| Wallet | Confidence | **Mismatch — reads as caution/bureaucracy** | The request-and-wait model is structurally the opposite of confidence |
| Results (won) | Pride | **Mismatch — reads as a routine notification** | Copy and visual weight don't match the size of the moment |
| Results (lost/refunded) | Mild disappointment, never confusion | **Mismatch when void-reason jargon appears** | Jargon converts a small emotional beat into a small cognitive task |
| Leaderboard | Competitive pride | Mostly matches, diluted by the scope/range decision gate | Fixing the default fixes the emotion |
| Profile | Pride in a track record | **Mismatch — reads as an identity/settings page first** | Win rate and streak are buried under bio fields instead of leading |
| Notifications | A friend telling you news | **Mismatch — reads as a system log** | Copy voice, addressed directly in Part 11 |
| Activity | Trust, transparency | Mostly matches | Already close to right |

---

# Part 11 — Language Audit

*Real copy patterns, reviewed for tone, length, and whether a first-time user would understand them without help. Rewrites offered where the current version fails any of those tests.*

**Already good, protect as-is:** the void-reason-aware player notices (each anomaly already gets distinct, plain-language copy rather than a raw status code — this is genuinely well done and should not regress); the transaction breakdown's line-item labels ("Platform fee," "Net prize pool") — precise without being cold.

**Needs a rewrite:**

| Where | Sounds like today | Should sound like |
|---|---|---|
| Deposit/withdrawal form field labels | Technical/administrative ("Transaction reference," "Payment method") | Plain and reassuring ("What did you send it as?" / "How'd you send it?") |
| Empty states across admin-adjacent player surfaces (e.g. "No results yet — try a search above") | Neutral, slightly cold, generic to any app | Specific to the moment ("No picks yet — once someone predicts, you'll see it here") |
| Entry-confirmation screen's fee line | Purely numeric ("Entry Fee × 1 / Total") | Restate the platform fee percentage in plain words here too, matching the transparency already shown elsewhere |
| Generic error states | Likely to read as system-speak by default in most forms | Should always name what went wrong and what to do next, never just "Something went wrong" |
| Win notification | Functionally a receipt | Should read like a friend, not a ledger — lead with the fact you were right, not the transaction |
| Any surface where a settlement or grading *version* or *snapshot* concept could leak into copy | Backend vocabulary | Should never appear in player-facing text under any circumstance — these are correctness mechanisms, not user concepts |

**Does the copy sound like a sportsbook, a social platform, or a bank, today?** It's split — the social surfaces (comments, notifications about people) sound right; the money surfaces (wallet forms, fee breakdowns) sound like a bank, and the rare status-notice edge cases sound like neither — they sound like an API response. The fix isn't a full rewrite; it's finishing the job the notice-copy system already started and extending its voice to the wallet and to error states.

---

# Part 12 — Mobile Audit

*Assuming 95% of usage is on a phone, one hand, on the move.*

**Thumb reach:** the bottom nav's five items and the raised create button are well within thumb range on any modern phone — correctly designed. The header (wallet pill, notification bell) sits at the top, which is inherently a two-handed or stretch reach on larger phones; this is standard and acceptable for *glanceable* elements (balance, notification count) but would be a real problem if either ever needed a frequent, fast tap rather than an occasional one.

**Tap targets:** the bottom nav's minimum touch-target sizing is correctly implemented. The one risk area flagged elsewhere in this review — a missing focus ring on the search input — is a keyboard/accessibility issue more than a touch one, addressed in Part 13.

**Scrolling:** the feed's vertical scroll is the product's best-executed interaction. The stories row's horizontal scroll is a well-understood, low-friction pattern. No desktop-style scroll behavior (hover-dependent reveals, scroll-jacking) was found anywhere in the player-facing surface.

**Gestures:** slide-to-confirm is a genuinely mobile-native gesture, well-chosen for the one moment (spending money) where a deliberate, weighted gesture is actually appropriate rather than excessive.

**Keyboard behavior:** the highest-risk area on mobile is any bottom sheet with a text input (comments, mentions, wallet forms) — when the keyboard opens over a sheet that's already anchored to the bottom of the screen, the available content area shrinks sharply, and long forms (the deposit request, in particular) are the most likely to feel cramped or require extra scrolling *inside* an already-constrained sheet. This is worth a direct check on a real device with a large on-screen keyboard.

**Bottom sheets:** used consistently and correctly as the primary "do a focused task" pattern (comments, entry confirmation, sharing, transaction detail) — this is the right mobile pattern, used well, everywhere it appears.

**Spacing / safe areas:** bottom-of-screen safe-area handling is correctly implemented for the nav bar; the same discipline should be verified on every bottom sheet, since a sheet that doesn't respect the same safe area as the nav bar directly underneath it would read as inconsistent the instant a user has both open in the same session (they won't, but the visual language should still match).

**Desktop thinking that leaked in:** none found in the player-facing product itself — the wide, data-dense admin layout is a deliberate, separate design decision for a separate audience, not a leak. The one place worth double-checking on mobile specifically is any screen presenting multiple numbers side-by-side (fee breakdowns, leaderboard rows with several stats) — these are the layouts most likely to have been eyeballed on a wide monitor during development and never stress-tested on the smallest supported phone width.

---

# Part 13 — Accessibility Audit

| Area | Finding | Recommendation |
|---|---|---|
| Contrast | The app's muted secondary-text color is likely borderline on WCAG AA at caption sizes in both light and dark themes | Run an actual contrast check and darken/lighten the token if it fails — this affects nearly every timestamp, label, and secondary line in the product |
| Typography | No dynamic-type/system-font-scaling behavior verified | Test the feed and wallet forms at the largest common accessibility text size before launch — a card that breaks at 200% text size is a real, common failure mode |
| Touch targets | Generally good in primary navigation | Verify the same minimum size on every icon-only button inside bottom sheets (close, reply, share icons), not just the persistent nav |
| Focus states | A visible keyboard-focus ring is missing on at least one primary text input (search) | Restore it — this is the single cheapest, highest-value accessibility fix available |
| Screen readers | Comment threads, entry confirmation, and share sheets all use real dialog semantics, which is correct | Verify the reading order inside each sheet actually matches visual order, especially where an icon-only button has no adjacent visible label |
| Loading states | **None exist** — every screen currently blocks fully until data is ready, with no skeleton or progressive state | This is both an accessibility and a perceived-speed problem (see Part 15) — a blank screen with no state announcement is a worse screen-reader experience than a labeled loading state |
| Skeletons | Absent everywhere | Add lightweight skeletons to the feed and pool detail at minimum — these are the two screens most likely to be opened on a slow connection |
| Error handling | Generally present, tone varies (see Part 11) | Standardize on specific, actionable error copy everywhere |
| Empty states | Present, mostly generic | Make every empty state specific to the screen it's on, which also naturally improves screen-reader-only users' understanding of what an empty screen means |

---

# Part 14 — Trust Audit

*Every moment a user could reasonably wonder "did that actually work."*

| Uncertain moment | Why it exists | How to eliminate it |
|---|---|---|
| "Did my prediction submit?" | The confirmation gesture is good, but the return-to-feed moment (Part 7) doesn't visibly mark success distinctly from ordinary scrolling | Give the just-entered pool a brief, visible "you're in" state the moment the user lands back on the feed |
| "Did my money leave?" (deposit) | The request-and-wait model has no visible state between "submitted" and "approved" | A clear, persistent "pending — usually reviewed within X" state, visible from the wallet screen at any time, not just at submission |
| "Did I actually win?" | The win moment is currently a standard-weight notification, indistinguishable in prominence from a routine one | Give a win a genuinely distinct visual/copy treatment — this is the highest-trust, highest-pride moment in the product and should look like one |
| "Where did my money go?" (a loss, or a fee) | **Already solved well** — the transaction detail sheet's breakdown is exactly the right answer to this question | Protect this, don't touch it |
| "Is this pool still open?" | A pool nearing its lock time doesn't currently signal urgency distinctly from one with hours left | A visible, honest countdown as lock time approaches removes ambiguity without inventing false urgency |

The common root cause across every real trust gap found here: **silence.** Every one of them is solved not by new functionality but by the product simply stating, out loud, in plain language, what's currently true and what to expect next.

---

# Part 15 — Speed Audit

*Perceived speed, not technical speed.*

**Feels instant today:** the like/comment interaction (optimistic, immediate visual feedback); the follow toggle; the slide-to-confirm gesture itself, which is deliberately weighted but never feels laggy.

**Feels slow, or ambiguous:** any full-page navigation with no loading state — because none exist anywhere in the product, every screen transition risks a blank flash on a slow connection, which reads as "did that tap register" even when the underlying request is genuinely fast. This is a perception problem entirely independent of actual server response time.

**Where skeleton loaders should appear first:** the feed (the single most-opened screen, and the one where a blank flash costs the most first-impression value) and pool detail (the screen a user lands on right after tapping into a card — a jarring blank moment here directly undercuts the excitement built up during the tap itself).

**Where optimistic UI should be used:** entering a pool itself is the highest-value candidate — showing the user's selection as "locked in" the instant they confirm, before the network round-trip resolves, removes the one moment in the core loop that currently has to wait on a server response before rewarding the user visually.

**Where animation should be removed, not added:** nowhere obvious was found — the one deliberate animation examined (slide-to-confirm) earns its weight. The recommendation here is the opposite of most speed audits: don't strip motion for speed's sake, add *state* (skeletons, optimistic feedback) so the motion that already exists reads as purposeful rather than as the only thing happening while everything else is silent.

---

# Part 16 — Friction Scorecard

| # | Issue | Severity | Frequency | Impact | Confidence | Suggested Solution | Effort | Priority |
|---|---|---|---|---|---|---|---|---|
| 1 | No loading/skeleton states anywhere | **Critical** | Every screen transition | High | High | Add skeletons to feed + pool detail first | Low | **P0** |
| 2 | Deposit/withdrawal has no visible "pending, expect X" state | **Critical** | Every deposit/withdrawal | High | High | Persistent status + stated timeframe | Low | **P0** |
| 3 | Win moment isn't visually distinct from a routine notification | High | Every win | High (this is the core emotional payoff) | High | Distinct copy + visual treatment | Low | **P0** |
| 4 | Six-rail payment choice | High | Every deposit | Medium-High | High | Default to one rail | Low | **P1** |
| 5 | Leaderboard requires two decisions before the payoff | High | Every leaderboard visit | Medium | High | Hard default, hide the matrix | Low | **P1** |
| 6 | Follow requires a full profile visit | Medium | Frequent | Medium | Medium | Inline follow button on avatar/comment | Low | **P1** |
| 7 | Missing focus ring on search input | Medium | Keyboard users only | Medium (for affected users) | High | Restore the ring | Trivial | **P1** |
| 8 | Void-reason jargon risk anywhere it leaks past the existing notice system | Medium | Rare, but high-cost when it happens | Medium | Medium | Audit every player-facing string for raw enum leakage | Low | **P1** |
| 9 | Profile leads with bio/settings, not track record | Medium | Every profile visit | Medium | High | Reorder — record first | Trivial | **P1** |
| 10 | Participation visibility (4 states) | Low-Medium | Set once, rarely | Low | High | Remove, default to visible | Trivial | **P2** |
| 11 | Profile field visibility (3 toggles) | Low | Set once, rarely | Low | High | Collapse to one | Trivial | **P2** |
| 12 | Per-follow email granularity | Low | Set once, rarely | Low | Medium | Collapse to one global setting | Trivial | **P2** |
| 13 | My-picks vs. Profile predictions tab redundancy | Medium | Occasional confusion | Medium | Medium | Merge | Low | **P2** |
| 14 | Fixture detail vs. Pool detail overlap | Low-Medium | Occasional | Low | Medium | Consider merging | Medium | **P2** |
| 15 | Analytics dashboard reads as a fintech tool | Low | Rare visits | Low | Medium | Fold top numbers into Profile | Low | **P2** |
| 16 | No re-stated fee % at the actual moment of spending | Medium | Every entry | Medium | High | Add one line to the confirmation sheet | Trivial | **P1** |
| 17 | No visible countdown as a pool nears lock | Medium | Every pool, near lock time | Medium | Medium | Add a plain countdown | Low | **P2** |
| 18 | Card administrative elements compete visually with social elements | Medium | Every card | Medium-High (compounding, feed-wide) | Medium | Reorder card hierarchy | Low | **P1** |
| 19 | Rule-pill dependency signals unclear question copy | Medium | Whenever it's actually needed | Medium | Medium | Fix question copy at the source | Medium | **P2** |
| 20 | No optimistic UI on pool entry | Low-Medium | Every entry | Medium | Medium | Show "locked in" pre-network-resolution | Low | **P2** |
| 21 | Deposit form field labels read as administrative | Low | Every deposit | Low-Medium | Medium | Rewrite in plain language | Trivial | **P2** |
| 22 | Contrast risk on secondary/muted text | Medium | Constant, low-grade | Medium | Low (needs measurement) | Run a real contrast check | Low | **P1** |
| 23 | No dynamic-type verification | Low | Accessibility-dependent users only | Medium (for affected users) | Low (untested) | Test at largest system text size | Low | **P2** |
| 24 | Return-to-feed after entering has no distinct "you're in" state | Medium | Every entry | Medium | Medium | Brief, visible confirmation state on the card | Low | **P1** |
| 25 | "Activity" isn't self-labeled in primary navigation | Low | New users specifically | Low-Medium | Low | Label the bell icon's destination once, on first use | Trivial | **P2** |

---

# Part 17 — Top 25 UX Improvements, Ranked

*Ordered by the combination of user impact, effort, simplicity gained, and emotional engagement gained.*

1. **Add skeleton loading states to Feed and Pool detail.** Highest-frequency screens, currently the most exposed to a blank-flash first impression, trivial relative effort.
2. **Give the win moment a distinct visual and copy treatment.** This is the product's single best emotional beat, currently under-dramatized — the cheapest possible fix with the highest possible payoff.
3. **State an explicit timeframe for deposit/withdrawal review.** Directly eliminates the product's single biggest trust gap with a sentence, not a feature.
4. **Default the leaderboard to one view.** Removes a decision gate in front of the product's second-best emotional beat (pride/competition).
5. **Restore the missing focus ring on the search input.** Trivial, protects real users, zero downside.
6. **Reorder every prediction card so social elements lead and administrative elements trail.** No new UI, pure hierarchy fix, compounds across every scroll of the feed.
7. **Reorder Profile to lead with win rate/streak, not bio fields.** Same principle applied to the second-most-visited personal screen.
8. **Restate the platform fee, briefly, at the entry-confirmation moment.** Closes the one real transparency gap already identified as otherwise strong.
9. **Default payment method to one rail.** Removes the single most consequential decision in the wallet flow.
10. **Add a brief "you're in" confirmation state after entering a pool.** Marks the flow's highest-confidence moment, which currently looks identical to idle scrolling.
11. **Collapse participation visibility to one default (visible).** Removes a decision with no discoverable value.
12. **Add an inline follow affordance without requiring a full profile visit.** Reduces the most common social action from 2 taps to 1.
13. **Collapse profile field visibility to a single toggle.** Same principle as #11, applied to identity settings.
14. **Collapse per-follow email granularity to one global setting.** Same principle again — the pattern of "one decision replacing three" recurs because it's the same underlying fix applied wherever it's found.
15. **Audit and eliminate any remaining raw status-code leakage in player-facing copy.** Protects trust exactly where jargon does the most damage — at the moment money didn't move as expected.
16. **Merge My-picks into Profile's predictions tab.** Removes redundant navigation and a memory tax.
17. **Rewrite deposit/withdrawal form labels in plain language.** Small effort, meaningfully softens the product's single coldest screen.
18. **Run a real contrast check on secondary/muted text and correct if it fails AA.** Protects readability for a meaningful share of users at essentially no design cost.
19. **Add optimistic "locked in" feedback to pool entry before the network round-trip resolves.** Makes an already-fast interaction feel instant, not just quick.
20. **Add a plain-language countdown as a pool nears its lock time.** Converts ambiguous urgency into honest urgency.
21. **Fix question copy at the source so the rule pill becomes a confirmation, not a requirement.** Slower to execute (touches every template), but removes a recurring comprehension tax.
22. **Consider merging Fixture detail into Pool detail.** Removes a screen whose distinct purpose isn't self-evident.
23. **Fold the player analytics dashboard's top two numbers into Profile; retire the dashboard as a destination.** Removes a screen that reads as the wrong emotional register for the rest of the product.
24. **Test the product at the largest common accessibility text size before launch.** Low effort, catches failures that would otherwise only surface in real user complaints post-launch.
25. **Label the notification bell's destination once, on first use, so "Activity" is discoverable rather than assumed.** Smallest item on this list, included because discoverability gaps compound silently and cost nothing to fix.

---

# Part 18 — What NOT to Change

**The feed's card-based, Instagram-derived visual language.** This is the product's single greatest asset. It is immediately legible, correctly familiar, and does more to establish "this is a social product" in the first five seconds than any amount of copy could. Touching its fundamental structure risks the one thing this whole report is trying to protect: the first impression.

**Slide-to-confirm on entry.** A genuinely well-chosen, well-weighted gesture for the one moment (spending real money) where a small amount of deliberate friction is correct, not excessive. Simplifying this further would remove intentional, valuable weight from the one decision that should feel considered.

**The fee-transparency pattern (shown on the card, then again in the transaction breakdown).** This is already doing exactly what transparency should do — informing without alarming, twice, at the two moments curiosity about it naturally arises. Do not consolidate this down to "once" in the name of simplicity; this is a place where the current level of repetition is a feature.

**The comment/mention/reply system.** Simple, human, and already working as the product's real social engine. No structural change is recommended anywhere in this report.

**The bottom-sheet pattern itself** (as distinct from its underlying code duplication, which is out of scope here). As a *UX* pattern, using a focused, slide-up sheet for comments, entry confirmation, sharing, and transaction detail is exactly right for a mobile-first product, and it should be the template any *new* focused interaction reaches for, not something to move away from.

**The stories row.** A correctly-scoped, correctly-executed use of a well-understood pattern, adding social texture to the top of the feed without adding a decision or a destination.

---

# Final Verdict

**Where do users hesitate the most?** The wallet — specifically the silent gap between submitting a deposit request and knowing whether it worked.

**Where do users smile the most?** The feed, in the first five seconds of any session, and again at the exact moment they discover they were right about a pick — though today that second moment is quieter than it deserves to be.

**Where are they most likely to quit?** Not during entry itself, which is fast and well-built — the real, invisible abandonment risk is a beat earlier, scrolling past a card whose question took a fraction of a second too long to parse.

**What makes Brohda memorable?** The exact moment a prediction resolves in your favor, in front of people who saw you make the call. Nothing else in the product comes close to this moment's potential, and nothing else in this report matters more than making sure that moment is treated with the visual and emotional weight it deserves.

**What single UX improvement would have the biggest impact?** Making the win moment feel as big as it actually is. Every other recommendation in this report removes friction; this one is the rare case where the fix is *adding emphasis*, not subtracting it — and it's the highest-leverage change available because it directly strengthens the one feeling the entire product exists to deliver.

**What three UX principles should guide every future design decision?**
1. **Silence is the enemy of trust.** Anywhere a user could wonder "did that work," the answer is always a missing sentence, never a missing feature.
2. **The payoff comes before the decision, not after.** Every screen that makes a user choose before it rewards them is a screen fighting its own purpose.
3. **People before mechanics, on every surface, every time.** Whatever administrative, financial, or system information a screen needs to convey, it earns the right to be shown only after the human element has already been seen.
