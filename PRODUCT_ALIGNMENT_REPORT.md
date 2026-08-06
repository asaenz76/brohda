# PRODUCT_SIMPLICITY_REVIEW.md

**A brutal product review of Brohda, conducted as if by Steve Jobs, Brian Chesky, Kevin Systrom, and Mike Krieger.**

This is not a code review. Nothing here concerns engineering quality, test coverage, or architecture. The only question this document asks, over and over, from sixteen different angles, is: **does this make Brohda simpler, clearer, faster, more social, and easier to love — or not?** If a feature can't answer yes, it's on the chopping block, regardless of how well it was built or how good the idea sounded in a planning session.

Every fact used here is real — pulled from the actual product as it exists today, not a hypothetical. The opinions are not real; they're an exercise in applying four people's well-documented philosophies to this specific product, as instructed. Nothing was protected because it was hard to build.

---

# Part 1 — One Sentence

**Attempt 1:** "Brohda is a social app where friends pay a small fixed fee to predict football match outcomes and split the pot, with comments, likes, and a leaderboard."

That's already 27 words and it's doing three jobs at once — describing the mechanic, the money, and the social layer. A one-sentence pitch shouldn't need a semicolon's worth of clauses to hang together.

**Attempt 2, forced to be actually one clause:** "Brohda is Instagram for football predictions."

That one works. It's memorable, it's a real comparison, and a stranger immediately knows what to expect. The problem is that **the product doesn't consistently earn that sentence.** The moment you go past the feed — into the wallet's manual payment-method request queue, into a pool creation wizard offering 17 templates across 5 pool types, into an admin console with health/lifecycle/synchronization tabs per competition and a live provider-quota circuit-breaker panel — "Instagram for football predictions" stops being an accurate description and starts being an aspiration.

**Why this matters:** if the one-sentence version only describes 60% of what's actually in the product, the other 40% isn't adding value — it's diluting the sentence. Every feature that doesn't fit inside "Instagram for football predictions" is a tax on how quickly a new user (or a new hire, or a friend you're trying to explain this to at a bar) understands what Brohda *is*.

---

# Part 2 — The Core Idea

**The ONE thing Brohda does:** you predict something about a football match with people you know, for a small fixed stake, and you find out — publicly, socially — whether you were right.

That's it. That's the whole product. Everything else is in service of that loop or it's noise.

**The three biggest things distracting from it:**

1. **Question-type proliferation.** Five pool types and 17 grading templates mean the simple act of "predict something" has been fragmented into a taxonomy. A new user doesn't experience "predict the match" — they experience "which of these five different kinds of prediction is this."
2. **The wallet feels like a bank teller line, not a feature of a social app.** Depositing money is a multi-step, admin-mediated, proof-of-payment request queue across six configurable payment rails. This is the least "Instagram" part of an app whose entire pitch is being Instagram-like.
3. **The admin console is bigger than the product.** There are more distinct admin screens (19+) than player-facing ones (14). An enormous amount of what this product *is*, operationally, is competition-catalog curation, provider-quota management, and multi-tab competition workspaces — none of which a player will ever see, and none of which makes the core loop better. It's real, necessary plumbing that has, over time, started to feel like a second product living inside the first one.

---

# Part 3 — Feature Inventory

*Every feature found in the product, grouped by area. Score legend: ★★★★★ Essential · ★★★★☆ Strong · ★★★☆☆ Useful · ★★☆☆☆ Weak · ★☆☆☆☆ Remove.*

### Core loop

| Feature | Why it exists | Real-world frequency | Feels like | Strengthens or weakens | Score |
|---|---|---|---|---|---|
| Social pool feed (card-based) | The product, full stop | Every session | Social | Strengthens | ★★★★★ |
| Entering a pool (pick + fixed fee) | The transaction that makes it a game | Every active user, per match | Social/game | Strengthens | ★★★★★ |
| Community sentiment bar | Shows the crowd's lean without odds | Seen constantly, rarely acted on directly | Social | Strengthens | ★★★★☆ |
| Comments (with @mentions, 1-level replies) | Social layer around the pick | Frequent on live/active pools | Social | Strengthens | ★★★★★ |
| Likes | Cheap social signal | Very frequent | Social | Strengthens | ★★★★☆ |
| Avatar stack (who else entered) | Social proof | Passive, always visible | Social | Strengthens | ★★★★☆ |
| Sharing (native + Instagram target) | Growth loop via existing social graph | Occasional | Social | Strengthens | ★★★☆☆ |
| Rule pill / grading-rule label | Explains how a pick settles | Glanced at, not read closely | Neutral | Neutral | ★★★☆☆ |
| Pool status notices (per void reason) | Explains why a pool didn't pay out | Rare (only on voided pools) | Neutral/legalistic | Weakens slightly (reads like a terms-of-service notice) | ★★☆☆☆ |
| Potential payout footer | Shows what you'd win | Every entry decision | Social/game | Strengthens | ★★★★☆ |

### Pool types & question design

| Feature | Why it exists | Real-world frequency | Feels like | Strengthens or weakens | Score |
|---|---|---|---|---|---|
| REGULATION_RESULT (1X2) | The most universal, obvious question | Constant | Football | Strengthens | ★★★★★ |
| TEMPLATE_GRADED — binary props (BTTS, total goals, margin) | Simple yes/no questions, easy to grade | Frequent | Football/social | Strengthens | ★★★★☆ |
| WHO_WILL_ADVANCE (knockout) | Needed for cup ties | Occasional (knockout rounds only) | Football | Neutral | ★★★☆☆ |
| TEMPLATE_GRADED — player props (card/goal-scorer style) | More granular questions | Rare | Football, edges toward sportsbook | Weakens | ★★☆☆☆ |
| TEMPLATE_GRADED — the other ~10 templates (minute-based cards, match-event props) | Coverage/completeness | Very rare | Sportsbook | Weakens | ★☆☆☆☆ |
| COMBO pools (2–10 legs, AND logic, super-admin only) | "Parlay"-style engagement | Rare — gated to one role, complex to grade | Sportsbook | Weakens | ★☆☆☆☆ |
| CUSTOM pool type | Legacy, no longer creatable | Never (dead feature still gradeable) | Neutral | Neutral | ★☆☆☆☆ |
| Recommendation engine (bookmaker-odds-evidence-driven "Recommended Questions") | Helps admin pick a good question | Every pool creation, admin-only | Sportsbook (literally sources bookmaker odds) | Weakens | ★★☆☆☆ |
| Conflict/mirror detection + override warnings | Prevents two near-duplicate pools on one fixture | Occasional, admin-only | Admin/legalistic | Neutral | ★★★☆☆ |
| Participation visibility (4 states) | Controls when the crowd-lean is revealed | Set once per pool, admin decision most users never think about | Admin | Weakens (unnecessary choice) | ★★☆☆☆ |
| Pool visibility (public vs. link-only "HIDDEN") | Private side-bets between a few friends | Occasional | Social | Neutral-to-strengthens | ★★★☆☆ |

### Wallet & money

| Feature | Why it exists | Real-world frequency | Feels like | Strengthens or weakens | Score |
|---|---|---|---|---|---|
| Wallet balance pill (always visible) | Trust — you always know your number | Constant | Social/trust | Strengthens | ★★★★★ |
| Deposit request (self-report + proof) | No payment processor exists | Every deposit | Bureaucracy | Weakens | ★★☆☆☆ |
| Withdrawal request | Same reason | Every withdrawal | Bureaucracy | Weakens | ★★☆☆☆ |
| 6 configurable payment rails (USDC/USDT/Venmo/CashApp/Zelle/Other) | Cover whatever the friend group actually uses | Constant admin overhead, low per-user value | Admin | Weakens | ★★☆☆☆ |
| Quick top-up (deposit + auto-enter one pool) | Removes a step for a specific case | Rare | Social/game | Strengthens (when it works) | ★★★☆☆ |
| Direct admin balance adjustment | Escape hatch for the request flow | Rare, admin-only | Admin | Neutral | ★★★☆☆ |
| Transaction history / activity feed | Trust, transparency | Occasional | Social/trust | Strengthens | ★★★★☆ |
| Transaction detail sheet (full fee breakdown) | Radical fee transparency | Occasional | Trust | Strengthens | ★★★★☆ |

### Social & profile

| Feature | Why it exists | Real-world frequency | Feels like | Strengthens or weakens | Score |
|---|---|---|---|---|---|
| Follow a user | Core social graph | Occasional, once per relationship | Social | Strengthens | ★★★★★ |
| Follow a team | Get notified when your team's fixture gets a pool | Occasional | Social/football | Strengthens | ★★★★☆ |
| Follow a league | Same, broader | Rare — mostly redundant with team follows | Football | Neutral | ★★★☆☆ |
| Per-follow email toggle (separately for teams and leagues) | Granular notification control | Set-once-forget | Admin-feeling | Weakens (a setting nobody asked for) | ★★☆☆☆ |
| Profile page (own) | Identity | Constant | Social | Strengthens | ★★★★★ |
| Profile page (others') | Discover/verify a friend's track record | Frequent | Social | Strengthens | ★★★★☆ |
| Pronouns / gender / bio fields, each with its own visibility toggle | Personalization | Set once, rarely revisited | Admin-feeling | Weakens (three settings for one idea: "show my bio or not") | ★★☆☆☆ |
| Followers/following lists | Social graph browsing | Occasional | Social | Strengthens | ★★★★☆ |
| Stories row | Instagram-pattern engagement hook | Constant (top of feed) | Social | Strengthens | ★★★★☆ |
| Streaks (current/best) | Gamified social proof | Passive, always visible on profile | Social/game | Strengthens | ★★★★☆ |
| Leaderboard (2 scopes × 3 ranges = 6 combinations) | Competitive social proof | Frequent | Social/game | Strengthens | ★★★★☆ |
| Search (users) | Find a friend | Rare | Social | Neutral | ★★★☆☆ |
| Player analytics page (streak timeline, monthly activity, financial overview) | Self-insight | Rare | Feels like a fintech dashboard, not a social app | Weakens | ★★☆☆☆ |
| My-picks page (separate from profile's predictions tab) | ? — unclear why this isn't just the profile tab | Rare | Redundant navigation | Weakens | ★☆☆☆☆ |
| Rules page | Explain the mechanics | Once, maybe, ever | Neutral, necessary | Neutral | ★★★☆☆ |
| Notifications (many distinct types, each with bespoke copy, polled every 20s) | Keep users informed | Constant | Social when about people, bureaucratic when about void reasons | Mixed | ★★★☆☆ |

### Admin & operations (the invisible half of the product)

| Feature | Why it exists | Real-world frequency | Feels like | Strengthens or weakens | Score |
|---|---|---|---|---|---|
| Competitions catalog (Recommended/Imported/Needs attention/All) | Curate which leagues generate pools | Occasional, admin-only | Enterprise SaaS | Necessary, but weakens the product's *feel* if a player ever sees it | ★★★☆☆ |
| Per-competition Workspace (health/lifecycle/settings/synchronization/templates — 5 sub-tabs) | Manage one league's sync/import state | Rare | Enterprise SaaS ops console | Weakens | ★★☆☆☆ |
| Provider Status panel (quota state, circuit breaker) | Prevent the sports-data API from getting throttled | Rare | Devops dashboard | Weakens (this is infrastructure wearing a product's clothes) | ★☆☆☆☆ |
| Fixtures management (3 separate modes: by-date/by-competition/by-fixture-ID) | Import matches | Occasional, admin-only | Admin | Neutral | ★★★☆☆ |
| Fixture archive (a *separate page* from Fixtures) | Historical record | Rare | Admin | Weakens (should be a filter, not a page) | ★★☆☆☆ |
| Pools admin (bulk archive/unarchive/delete) | Housekeeping | Occasional | Admin | Neutral | ★★★☆☆ |
| Pool detail admin (settlement review, manual grading, reversal, cancel) | The actual grading workflow | Every settled pool | Admin, but this is load-bearing | Necessary | ★★★★☆ |
| Admin hierarchy (`parent_admin_id` tree, depth-capped at 50) | Presumably: sub-teams of admins reporting to a parent admin | Essentially never at current team size | Enterprise org-chart software | Weakens | ★☆☆☆☆ |
| Invitations management | The only door into the product | Occasional | Necessary | Necessary | ★★★★☆ |
| Settings (registration toggle, fee defaults, payment methods) | Platform config | Rare | Admin | Neutral | ★★★☆☆ |
| Reports | ? | Unclear if used | Admin | Weakens | ★☆☆☆☆ |
| Admin analytics (platform-wide + top users) | Business insight | Rare | Admin/fintech | Neutral | ★★★☆☆ |
| Audit log | Accountability trail | Rare, read only after something went wrong | Admin | Necessary, invisible | ★★★☆☆ |

### Spotlight — the features worth arguing about out loud

- **COMBO pools.** Nobody is asking a friend group to reason about a 6-leg parlay. This is the single most "sportsbook" feature in the entire product, gated to a role that's presumably one or two people, and it exists because multi-leg parlays are a *familiar betting-industry pattern* — not because Brohda's own users asked for it. **Would anyone complain if it was removed? Almost certainly not — and the ones who might are the exact users a friend-group prediction app shouldn't be optimizing for.**
- **Provider Status / circuit breaker panel.** This is real, good engineering solving a real ops problem (an external API running out of quota). It should absolutely keep existing *as a safety mechanism*. It should not exist *as a product screen with its own nav entry*. Nobody using Brohda should ever need to know what a "circuit breaker" is.
- **Participation visibility's 4 states + team/league follow's separate email toggles + profile's 3 separate show/hide fields.** Individually defensible. Collectively, they're the exact pattern Steve Jobs spent his career deleting: three different UI surfaces solving what is, from the user's perspective, one idea ("show this or don't").
- **My-picks page vs. Profile's predictions tab.** Two places to see what a user picked. If they show the same information, one of them is redundant navigation. If they show different information, that's worse — it means the user has to remember which page has what.
- **Admin hierarchy tree.** This is scaffolding for an admin team that doesn't exist yet, built into the schema (`parent_admin_id`, cycle detection, depth caps) before there's a second layer of admins to manage. This is the single clearest case of building for a future org chart instead of the product in front of you.

---

# Part 4 — Screen Review

*Grouped by area. "Feels like" flags anything reading as admin software, sportsbook software, or genuine social media.*

### Player-facing screens (14)

| Screen | Why it exists | Can disappear or merge? | <5s to understand? | <30s to complete task? | Feels like |
|---|---|---|---|---|---|
| Feed | The product | No | Yes | N/A (browsing) | Social |
| Pool detail | See one pool in full, enter it | No | Yes | Yes | Social |
| Fixture detail | See all pools tied to one match | **Could merge into Pool detail as a "more pools on this match" section** | Yes | Yes | Social |
| Wallet | Balance + deposit/withdraw | No, but the *flow inside it* needs work | Yes (balance) / No (request form) | No — multi-field proof-of-payment form | Bureaucracy inside a social screen |
| Activity | Wallet history + notifications combined | Sensible merge already done | Yes | N/A | Neutral |
| Profile (own) | Identity | No | Yes | N/A | Social |
| Profile (others') | Same | No | Yes | N/A | Social |
| Followers / Following lists | Social graph | Could be a modal instead of a full page navigation | Yes | Yes | Social |
| Leaderboard | Competitive ranking | No | Yes | N/A | Social/game |
| My-picks | ? | **Should merge into Profile's predictions tab** | Unclear what distinguishes it | N/A | Redundant |
| Analytics (player) | Personal stats dashboard | **Could be a section of Profile, not a standalone destination** | No — multiple charts, filters | N/A | Fintech dashboard |
| Search | Find people | No | Yes | Yes | Social |
| Rules | Static explanation | **Could be a help sheet, not a full page** | Depends on length | N/A | Neutral |
| Register / Login / Reset password / Invite accept | Auth | No, necessary | Yes | Yes | Neutral |

### Admin screens (19+)

The honest headline here: **there are more admin screens than player screens, in a product whose entire identity is a simple social feed.** That imbalance is itself a finding, independent of any single screen's quality.

| Screen | Why it exists | Can disappear or merge? | Feels like |
|---|---|---|---|
| Competitions (4 tabs) | Curate leagues | Necessary, but 4 tabs for "pick which leagues we support" is a lot | Enterprise SaaS |
| Competition Workspace (5 sub-tabs per competition) | Manage one league | **Collapse health/lifecycle/synchronization into one "Status" tab** | Enterprise ops console |
| Provider Status panel | Quota/circuit-breaker visibility | **Should be a small badge somewhere, not a destination** | Devops dashboard |
| Fixtures (3 modes) | Import matches | The 3-mode split (date/competition/fixture-ID) could be one search box with smart filters | Admin tool |
| Fixture archive | Historical fixtures | **Merge into Fixtures as a filter/tab, not a separate page** | Admin tool |
| Pools list + Pool detail | Manage/grade pools | Necessary, load-bearing | Admin, appropriately |
| Pool creation wizard | Build a pool | Necessary, but the template-picker screen alone tries to do too much (recommendation scoring + conflict warnings + 17 templates in tabs) | Enterprise config tool |
| Users + User detail | Manage accounts | Necessary | Admin, appropriately |
| Invitations | The only signup door | Necessary | Neutral |
| Settings | Platform config | Necessary | Neutral |
| Reports | ? | Unclear value; audit whether anyone opens this | Admin |
| Admin Analytics | Platform insight | Could merge with Reports | Admin |
| Audit log | Accountability | Necessary, invisible until needed | Admin |
| Wallet-requests | Approve deposits/withdrawals | Necessary given the current wallet model — but this entire screen is the *product's* payment processor. That's the tell that the payment model itself is the thing to fix, not this screen. | Bureaucracy |

**The single biggest screen-level finding:** the pool creation wizard and the Competition Workspace are, between them, more complex than the entire player-facing app. If Brohda's core identity is "simple," the parts of the product that build the thing players see should not be the most complicated parts of the codebase.

---

# Part 5 — Workflow Review

### Registration
Two parallel paths (self-service toggle + invite token) exist simultaneously. **Lose a decision:** pick one. An invite-only social product (which is what Brohda's own identity implies — "friends," not "the public") doesn't need a self-service registration toggle sitting in Settings as a live option. Every extra path is a path someone has to reason about, including the founder deciding whether it's on.

### Onboarding
There isn't a dedicated onboarding flow beyond profile completion (forced username/basic-field entry before you can do anything). **Lose a step:** the forced profile-completion redirect fires for admins too, which means even a staff account has to fill out a bio-adjacent form before touching the admin panel. That's a decision (profile completeness) applied uniformly to a case (admin access) where it adds nothing.

### Finding a PollPool
This *is* the feed — you don't "find" one, you scroll. Good. The only friction: fixture detail exists as a separate screen from pool detail, so "see all the ways to predict on this match" requires a navigation hop the feed itself could show inline (e.g., a "3 more pools on this match" chip on the card).

### Entering a PollPool
Tap option → confirmation sheet → slide to confirm → done. This is close to ideal already — one decision, one confirmation, no unnecessary steps. **The only thing to question:** does "slide to confirm" need to exist for every entry, or only above some stake threshold? A $1 friendly bet with your roommate probably doesn't need the same confirmation ceremony as a $50 one.

### Wallet
This is the workflow with the most steps to lose. Today: navigate to Wallet → pick a payment method → read destination/instructions → send money externally → come back → fill out a request form with an amount and a transaction reference as proof → wait for an admin to notice and approve it → check back later to see if it posted. **That's seven steps and a wait for something that should feel like Venmo.** Lose the multi-rail choice (pick one canonical rail), lose the "prove you paid" text field by automating verification wherever the rail allows it, and lose the wait by giving admins a same-day SLA expectation baked into the UI copy instead of silence.

### Following users
One tap, toggles. Already minimal. No change needed.

### Viewing profiles
Fine. The only decision worth questioning: three independently-toggleable visibility fields (pronouns/gender/bio) is three decisions where one ("show extra profile info: yes/no") would do.

### Leaderboards
Two scope tabs × three range options = 6 states behind 2 controls. **Lose a decision:** does a friend-group product need "weekly" *and* "monthly" *and* "all-time," or does one rolling window plus all-time cover what anyone actually checks? Every additional range is a dropdown a user has to notice, understand, and choose not to explore.

### Notifications
Fine as in-app; the 20-second poll is an invisible implementation detail, not a user-facing complexity problem. The complexity here is on the *authoring* side — a long tail of distinct notification "types" each with bespoke copy for a dozen-plus void reasons. A user doesn't need to know the pool was voided because of `MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY` versus `MATCH_ABANDONED` — "This match didn't finish, so you got your money back" covers both, and every other anomaly reason, in one sentence.

### Settlement
Invisible to players when it works, which is correct — you get paid or notified, no interaction required. The complexity here (a versioned settlement/reversal/manual-review state machine) is backend correctness, not user-facing workflow, and doesn't belong in this section's scoring. Leave it alone.

### History
Combined into Activity already. Good. No further steps to lose.

---

# Part 6 — KISS Violations

**Too many pool types.** Five types, only two of which (REGULATION_RESULT and simple TEMPLATE_GRADED binaries) cover the vast majority of real usage. Every additional type is a fork in the mental model a new user has to build before they can predict with confidence.

**Too many templates.** 17 grading templates is a taxonomy, not a feature set. This violates KISS because the cost isn't just engineering — it's that a pool creator (admin) now has to *choose* from 17 options every time, which is a decision-paralysis tax on the one moment (creating the question) that should be fastest.

**Too many visibility settings.** `participation_visibility` (4 states) + `pool_visibility` (2 states) + three separate profile-field show/hide toggles + two separate per-follow email toggles = eight distinct binary/enum settings a user or admin can set, most of which default correctly and are never revisited. Each one is a line of documentation, a line of support-question risk, and a line of code that has to be right forever. KISS says: default it, don't expose it, unless someone has actually asked for the control.

**Too many payment methods.** Six configurable rails, each admin-maintained (destination + instructions), for a closed friend group that almost certainly clusters around one or two real payment habits. This is optionality nobody asked for, purchased at the cost of an admin having to keep six things up to date.

**Too many admin tabs.** Competitions has 4 tabs; a single Competition Workspace has 5 sub-tabs. That's 9 distinct admin surfaces to manage what is, from a player's perspective, an invisible background process ("the app knows what leagues exist").

**Too many statuses.** 12 pool statuses, 12+ void reasons, multiple review-reason codes. Necessary for money correctness on the backend — but every one of these that leaks into a notification, a pool card, or an admin table as distinct copy is a concept a human has to learn. Collapse the *player-facing* vocabulary to roughly three outcomes ("you won," "you lost," "this didn't count, here's your money back") regardless of how many statuses the database needs internally.

**Too many colors, technically zero — but too many meanings.** The color system itself is disciplined (one semantic meaning per accent color, confirmed by the architecture review). The violation isn't color count, it's that so many *states* now need a color: pool status, entry status, import status, sync status, review status. Even a well-designed palette strains when it has to represent this many distinct concepts.

**Too many concepts, full stop.** A user of this product needs to eventually understand: pool types, participation visibility, pool visibility, void reasons, wallet requests, payment rails, follow types (user/team/league), leaderboard scope/range, streaks, and profile visibility toggles. That's ten distinct concepts for a product whose one-sentence pitch is "predict football outcomes with friends."

---

# Part 7 — Product Drift

| Principle | Verdict | What caused the drift | How to fix it |
|---|---|---|---|
| Social-first | Mostly holding | The admin/ops surface (competitions, provider status, fixtures) has grown large enough that a meaningful share of the product's *total surface area* is now non-social infrastructure. Drift by addition, not by intent. | Nothing player-facing needs to change; discipline the admin side so it never leaks into player screens or player-facing language. |
| Instagram-inspired | Holding strongly | No drift found — the feed, cards, stories row, and share sheet all genuinely earn the comparison. | Keep protecting this; it's the one area with zero notes. |
| Football-first | Holding | No drift — the domain model stays football-specific where it should. | No action needed. |
| Equal competition | **Drifting** | A beta-only relaxation lets a pool's entry fee change *after* people have already staked money at the original price. That's not equal competition anymore — it's a moving target. | Revert the relaxation on a firm date, not "when we get to it." |
| Community sentiment | Holding | The distribution bar is real, honest, and correctly labeled. | No action needed. |
| Transparency | Holding, one exception | The confirmation screen for actually spending money doesn't restate the fee percentage — it's visible upstream on the card, not at the point of commitment. | Show the fee one more time, right where the money leaves. |
| Simple economics | **Drifting** | Six payment rails, an admin approval queue, and a quick-top-up side-flow are not simple economics — they're workable economics with a lot of moving parts. | Consolidate to one primary rail; treat the rest as manual overrides, not first-class configured options. |
| Simple UI | **Drifting** | The wizard-heavy admin console and the granular visibility settings are the main offenders; the player UI itself hasn't drifted much. | Apply the same "one canonical way to do X" discipline used in the design-token system to the *feature* surface, not just the color system. |
| Simple rules | **Drifting** | 5 pool types × 17 templates × 4 visibility states × 12+ void reasons is not simple rules, even if each individual rule is simple to explain in isolation. | Cut pool types to 2, templates to the 4–5 that actually get used, visibility states to 2. |

---

# Part 8 — The Steve Jobs Review

*He opens the app. He doesn't say anything for the first ninety seconds. Then:*

"The feed is good. I believe you that this is a social app when I'm looking at the feed. Then I tap into creating a pool as an admin and I'm looking at a template picker with more tabs than iTunes had in 2003, and I stop believing you.

**The first thing I'd delete:** COMBO pools. This is a parlay. You built a parlay feature for a friend group. Nobody in this friend group is asking for a parlay. This exists because someone, somewhere, thought 'what if people could combine bets' sounded clever in a meeting. Delete it. If someone genuinely wants a multi-leg bet, they can make two pools and talk about it in the comments — which, by the way, is more social than a parlay ever would be.

**The second thing I'd delete:** the admin hierarchy tree. You have `parent_admin_id`, cycle detection, a depth cap of fifty. Fifty. You have, what, two or three admins? This is an org chart for a company you don't have yet. I don't care that it's already built. Delete it. Build it again in eighteen months if you actually need it, and I promise you the version you build then, once you know what you actually need, will be better than the one you're carrying today on faith.

**The feature I'd refuse to ship:** the provider status panel as a navigable screen. Not because it's wrong to build — you should absolutely protect yourselves from a third-party API running out of requests — but because it does not belong in a product menu. A circuit breaker is something the engine does. You don't put a dashboard for the transmission on the dashboard of the car.

**The screen I'd redesign:** the wallet. Everything else in this app respects my time. The wallet does not. I have to pick a payment method from a list of six, read instructions, leave the app, come back, and fill out a form proving I did something you can't verify yourselves. That is the opposite of everything else you've built. Fix the wallet before you build one more social feature, because right now the worst experience in your product is the one tied directly to money, and that's backwards — the money part should be the *most* trustworthy, most frictionless part, not the least.

**The sentence I'd rewrite:** anything that starts with 'This pool has been voided because...' followed by a database enum. Nobody needs to know it's `MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY`. They need to know: the match didn't finish, here's your money back. Say that. Say it the same way every time, regardless of which of your twelve reasons caused it.

**The philosophy I'd insist on protecting:** the color system. Somebody on this team already understands what I'm talking about — one meaning per color, enforced everywhere, no exceptions. That's the right instinct. I want that same instinct applied to *features*, not just colors. One way to predict. One way to pay in. One way to see who's winning. Everything else is a compromise you talked yourself into."

---

# Part 9 — The Brian Chesky Review

*He focuses less on features, more on how it feels to trust this product with his money and his friendships.*

"The first fifteen minutes with any product are everything — that's when someone decides whether they belong here. Your first fifteen minutes are good: someone invites you, you land in a feed of real people you know making real predictions, and it feels alive. That's the Airbnb instinct done right — you don't onboard with a form, you onboard into a community that's already happening.

Then I try to put money in, and the feeling changes completely. I'm filling out a form and *waiting for a human to trust me.* That inversion — where the app that's supposed to be about trusting your friends suddenly doesn't trust *me* enough to move my own money — is the single biggest emotional break in the product. At Airbnb we obsessed over the moment a guest wonders 'will this actually work out.' Your wallet is that moment, and right now the answer the product gives is 'maybe, once someone gets around to it.'

**What I'd remove:** the six payment methods. Optionality feels generous but it isn't — it's you asking the user to do research before they can trust you. Pick the one rail your actual users already use for splitting a dinner bill, make that flawless, and only add a second one when real demand, not hypothetical completeness, asks for it.

**What I'd simplify:** the distance between 'I lost' and 'I want to try again.' Right now a void or a loss surfaces as a database-flavored notification. I'd want that moment to feel like the community, not the system, talking to you — more 'tough one, get 'em next time' and less 'MATCH_STATUS_UNKNOWN.' Money moments are trust moments. Every one of them should feel human, even the automated ones.

The thing I'd protect without question: the fee transparency. Showing the platform fee on the card, before anyone commits, and again in the transaction breakdown afterward — that's real trust-building, and it's rare. Most products bury the fee. You're showing it twice. Don't let anyone talk you into hiding it to make the number look cleaner. Clarity is the product here, not the number."

---

# Part 10 — The Instagram Review

*Kevin Systrom and Mike Krieger, reviewing together.*

"We'd recognize this as a social product — mostly. The feed reads right: cards, avatars, likes, comments, a stories row up top. That part earns the comparison honestly. But the moment you go one layer deeper, some of it starts to feel like a betting product wearing a social skin rather than a social product that happens to involve a wager.

**Feed:** good instinct, real execution. Cards feel like posts, not like bet slips.

**Profiles:** solid, but three separate visibility toggles for pronouns/gender/bio is the opposite of what we did with Instagram bios — we made it one open text field and trusted people to share what they wanted. You've turned 'share a little about yourself' into a settings page. Cut it back to one toggle: show extra info or don't.

**Cards:** good. The one thing we'd push on — does every card need the same weight? On Instagram, not every post is a Story, not every Story is a Reel. Here, every pool looks the same regardless of whether it's a $1 friendly bet or a serious multi-way prediction on a rivalry match. Some visual differentiation by stakes or energy would make the feed feel more alive, not less simple.

**Comments:** genuinely good — mentions, one level of replies, no over-engineering. Leave this exactly as it is.

**Activity:** combining wallet history and notifications into one feed was the right call. We'd have made the same choice.

**Leaderboards:** six states behind two dropdowns is one dropdown too many. We shipped Instagram with one feed algorithm choice for years — chronological — and it worked because nobody had to think about it. Give people one leaderboard that's obviously *the* leaderboard, and only add a toggle once people start actually asking where the weekly one went.

**Notifications:** the actually-social ones (someone you follow entered a pool, a reply to your comment) are exactly what we'd build — they pull you back in. The void-reason notifications read like customer support tickets. Split the voice: social events sound like a friend, system events should be as short and human as possible.

**Sharing:** the dedicated Instagram share target, with a correctly-handled fallback for the fact that Instagram doesn't support arbitrary deep links — that's the kind of small, unglamorous correctness we'd respect. Keep it.

**Visual hierarchy / scrolling:** would we make the feed more addictive? Yes — and the honest way to do it isn't a new feature, it's tightening what's already there. Every extra pool-type/visibility-state/status color that shows up *in the feed itself* is friction against the scroll. The feed should be the simplest, fastest-reading part of the entire product, and every one of the settings and states cataloged elsewhere in this review is a tax on that speed if it ever surfaces on a card.

**Would we remove anything?** COMBO pools, without hesitation — a parlay card breaks the one-glance readability that makes a feed addictive; you'd have to read it, not scan it. And we'd push hard on collapsing pool types before adding anything new. Burbn — the app that became Instagram — had check-ins, plans, points, and photo-sharing bolted together, and the entire company bet its future on deleting everything except the one thing people actually loved. That's the move available here too: you already know which parts of Brohda people love, because the feature-usage story in this review is not subtle. Do the Burbn thing. Cut down to the loved part, and go all-in on it."

---

# Part 11 — The Founder Trap

Ruthlessly, here's what exists because it seemed like a good idea, not because users asked for it:

- **COMBO pools.** A parlay feature nobody in a closed friend group requested — it exists because parlays are a familiar betting-industry pattern, not a Brohda-native one.
- **Admin hierarchy tree.** Org-chart infrastructure for an admin team that doesn't exist yet.
- **17-template grading registry.** Built for completeness ("what if someone wants a red-card-after-minute-60 market"), not for demand.
- **Recommendation engine sourced from live bookmaker odds.** This quietly imports sportsbook thinking into the one moment (question creation) that most defines whether Brohda feels like a betting product or a friend-group game.
- **Participation visibility's 4 states.** Nobody asked "can I control exactly when the crowd-sentiment bar appears relative to my own entry" — an engineer solved a problem that didn't have a user behind it yet.
- **Six payment rails with individual admin configuration.** Built for "cover every case" rather than "solve the actual case."
- **Provider Status / circuit-breaker panel as a UI.** A real engineering safeguard that graduated into a product screen it never needed to be.
- **Fixture Archive as a separate page from Fixtures.** A filter turned into a destination.
- **My-picks as a separate page from Profile's predictions tab.** Two places for one idea, likely because it was faster to add a new route than to reconcile it with an existing one.
- **Player analytics dashboard.** A fintech-style feature added because the data was already there to compute it, not because a casual friend-group bettor asked for a monthly-activity chart.
- **Separate email-notification toggles per team-follow and per league-follow.** Solved for a granularity of control that a single global "email me or don't" setting already covers for 95% of users.

The pattern across all of them: **each one is defensible in isolation and none of them is load-bearing for the one-sentence pitch.** That's exactly the founder trap — nothing on this list is a bad idea by itself. The mistake is having shipped all of them.

---

# Part 12 — The 80/20 Rule

**What to delete today, and why:**

1. **COMBO pools** — highest "sportsbook feel per unit of usage" ratio in the product.
2. **Admin hierarchy tree** — solving an org problem that doesn't exist yet.
3. **12+ of the 17 grading templates** — keep the ~5 that actually see real usage (1X2, BTTS, total goals, margin, one or two more), retire the long tail.
4. **Participation visibility's 4 states → 2** ("visible" / "hidden until settled").
5. **6 payment rails → 1–2.**
6. **My-picks page** — fold into Profile.
7. **Fixture Archive page** — fold into Fixtures as a filter.
8. **Player analytics dashboard** — fold the one or two numbers people actually care about (win rate, streak) into Profile; delete the rest.
9. **Provider Status as a navigable screen** — demote to a small status indicator, not a destination.
10. **Separate per-team/per-league email toggles** — collapse to one global notification-email setting.

**What improves because of it:**

- The pool creation wizard shrinks from "choose among 17 things" to "choose among 5," which directly speeds up the moment that creates every player-facing card.
- The admin nav shrinks by roughly a third, which means fewer places for a new admin (or an admin two years from now who's forgotten the details) to get lost.
- The product's *actual* surface area gets closer to matching its one-sentence pitch — which is the whole point of this exercise.
- Every deleted setting is a support question, a QA case, and a line of documentation that no longer needs to exist, forever.

Nothing on this list touches the feed, comments, likes, follows, wallet balance display, or settlement correctness. The core loop is untouched. That's deliberate — the 80/20 cut here is entirely in the optionality and admin-tooling layer, not the thing people actually love.

---

# Part 13 — The 50% Challenge

*Brohda launches tomorrow with half the current features. Here's what survives.*

**Survives:**
- The social feed of pool cards (comments, likes, avatar stack, sentiment bar)
- Entering a pool (one pool type: 1X2, plus simple binary TEMPLATE_GRADED props)
- Wallet balance + one payment rail, admin-approved
- Follows (user only — team/league follows fold in later if there's real demand)
- Leaderboard (one scope, one range: all-time)
- Notifications (won/lost/refunded + social events only, no void-reason taxonomy exposed)
- Profile (identity, streak, win rate — no dashboard)
- Settlement/reversal correctness on the backend (invisible, non-negotiable)
- Invite-only registration
- The minimum viable admin console: import a fixture, create a pool, grade it, approve a wallet request

**Removed:**
- COMBO pools
- 12+ of the 17 templates
- WHO_WILL_ADVANCE as a distinct type (fold knockout handling into the same 1X2 flow with a "no draw" flag, rather than a whole separate pool type)
- Team/league follows and their granular email toggles
- Player analytics dashboard
- My-picks, Fixture Archive, Rules as standalone pages
- Admin hierarchy
- Provider status panel as a screen
- Reports
- Multiple leaderboard scope/range combinations
- Five of the six payment rails
- Participation visibility settings (hardcode one sensible default)

**Why these survive and not the others:** every surviving feature is either (a) the literal core loop, (b) genuine trust infrastructure (wallet, settlement correctness), or (c) the minimum social layer that makes it feel alive rather than transactional. Everything removed is optionality, completeness, or infrastructure that leaked into product surface. This is, not coincidentally, close to what "Instagram for football predictions" would actually contain if you built it from scratch today with nothing to protect.

---

# Part 14 — What Not To Build

Attractive-sounding ideas that should stay unbuilt:

- **Live odds or spreads.** The community-sentiment bar is the right amount of "what does the crowd think" — real odds would turn Brohda into a sportsbook overnight, no matter how it's labeled.
- **More pool types / more granular prop markets.** Every addition here is a step toward "comprehensive betting platform" and a step away from "simple game with friends." The instinct to add more markets should be treated as a warning sign, not a roadmap item.
- **Additional payment rails.** Every new rail is an admin maintenance burden and a user decision-point; the fix for "our users want a different rail" is to swap the one rail, not add a seventh option.
- **A public/global leaderboard across unrelated friend groups.** This breaks the "equal competition, community" principle by pitting strangers against each other for bragging rights that don't mean anything outside a real relationship. Keep the leaderboard inside the circle of people who actually know each other.
- **A chat/DM system.** Comments already carry the social weight this product needs. A DM system is a different product (a messenger) bolted onto this one, and it's exactly the kind of "seemed like a good idea" feature this review exists to catch before it gets built.
- **Badges/achievements beyond streaks.** Gamification creep is real — once you add one badge, there's no natural stopping point, and every badge added after the first is diminishing-returns dopamine engineering that doesn't strengthen any of the seven core principles.
- **Multi-sport expansion before football is fully loved.** Adding basketball or tennis today would double the domain complexity (rules, scoring, templates) before the football version has proven it's unforgettable. Football-first means football-*only*, for now.
- **A configurable "custom rules" builder for admins to invent new grading logic in the UI.** This sounds empowering; it's actually an invitation to recreate the 17-template sprawl this review is asking you to cut, except now it's user-generated and even harder to keep simple.
- **Push notifications for every micro-event** (every like, every comment on a pool you're not in, every leaderboard shuffle). The instinct to "increase engagement" through notification volume is the single fastest way to make a beloved product start to feel like spam.

---

# Part 15 — Future Complexity

**Where Brohda is likely to bloat over the next two years, if nothing changes:**

1. **The template registry keeps growing.** Every new admin request ("can we add a market for X") becomes a new template rather than a variant of an existing one, and 17 becomes 30.
2. **The admin competition-management surface keeps growing** as more leagues are added — each new league is currently a config entry, but the temptation will be to add per-league settings, and per-league settings become per-league screens.
3. **Notification types keep multiplying** as new events are added one at a time, each with its own bespoke copy, instead of being written against a small, closed vocabulary of outcomes.
4. **Payment rails keep growing** one at a time as individual users ask for "just one more option," each accepted in isolation because saying no to one request feels small.
5. **The admin hierarchy, once built, starts getting used** simply because it exists — a second admin gets assigned a `parent_admin_id` not because the structure is needed, but because the field was already there.
6. **"Just one more visibility setting" becomes a pattern** — every new feature ships with its own show/hide toggle by default, because that's the path of least resistance for whoever builds it, not because anyone asked for the control.
7. **Analytics features compound** — once a dashboard exists, every new metric that's technically available gets added to it, because the marginal cost of one more chart feels small each time, even though the cumulative cost is a fintech-dashboard feel creeping into a social app.

**What would prevent it, decided today, not later:**

- **A standing rule: no new pool type or template ships without deleting or merging an existing one.** Net-neutral or net-negative feature count, always.
- **A single person (or a standing five-minute agenda item) whose job is explicitly to say no** to "can we add a setting for that" — every setting defaults to *not existing* until real, repeated user demand proves otherwise.
- **A closed, versioned vocabulary for player-facing outcomes** (won / lost / refunded / pending) that new backend statuses must map *into*, rather than each new backend status getting its own player-facing notification copy.
- **A hard cap on payment rails** (e.g., never more than 2 active at once) enforced as policy, not just as a technical possibility.
- **Delete the admin hierarchy now**, before a second admin is ever assigned a parent — it's much easier to not build a thing than to un-adopt one that's already technically live.
- **A "does this belong in the feed" test for every new feature**: if it can't be represented as something that would look natural on an Instagram-style card, it doesn't ship as a first-class feature — it ships as a setting buried in the profile/settings screen, or it doesn't ship.

---

# Part 16 — Final Verdict

**What should be deleted immediately:**
COMBO pools. The admin hierarchy tree. The Provider Status panel as a navigable screen. My-picks and Fixture Archive as standalone pages. Twelve of the seventeen grading templates. Five of the six payment rails. Participation visibility's four states, collapsed to two.

**What should be simplified:**
The wallet's deposit/withdrawal flow (fewer steps, fewer rails, faster trust). The leaderboard's scope/range matrix (one obvious default, not six combinations). Notification copy (a closed, human vocabulary of outcomes instead of a database enum leaking into a push notification). The pool creation wizard (fewer templates, less bookmaker-odds machinery visible to the person creating the question).

**What should never have been built:**
The recommendation engine sourcing live bookmaker odds to suggest questions — the single feature most at odds with "never a sportsbook." The admin hierarchy tree, built for an org that doesn't exist. COMBO pools, a betting-industry pattern imported wholesale into a product that explicitly rejects that identity.

**What should become the heart of Brohda:**
The feed. Not "the feed plus the wallet plus the admin console plus the analytics dashboard" — just the feed: real people, real picks, real stakes, real reactions, scrolling by in a rhythm that feels alive. Everything else in the product should exist only to make that one screen better, faster, and more trustworthy. Nothing else should compete with it for the founder's attention, the engineering team's roadmap, or the user's first fifteen minutes.

**If only five features survive, these are the five:**

1. **The social pool feed** — cards, comments, likes, sentiment bar. This is the product; without it there is no Brohda.
2. **Entering a pool** — one clean, fast, trustworthy transaction. This is the verb that makes the feed a game instead of a timeline.
3. **The wallet balance + one simple, trustworthy way to add money.** Money has to be boring and instant, or nothing else matters.
4. **Follows + leaderboard.** This is what makes it a competition among *people you know*, not a feed of strangers' bets — the single most defensible, hardest-to-copy part of the product.
5. **Honest settlement + notification.** You win, you lose, or it didn't count — said plainly, paid out reliably, every time. This is the trust the entire product is built on, and it's the one thing that, if it ever breaks, nothing else here matters.

Everything else — every template, every visibility toggle, every admin sub-tab, every payment rail beyond the first — is optionality Brohda can survive without. These five things are the ones it can't.
