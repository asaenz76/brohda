# Terms / Privacy — Brohda 2.0 coherence pass: OWNER / COUNSEL REVIEW REQUIRED

> **Status: not legal advice, and not approved.** This document accompanies a copy pass on `/terms` and `/privacy`. Engineering corrected
> *factual product descriptions* that were plainly obsolete (the old private-group "Pool" product). It did **not** make, and this
> document does not claim to make, any legal judgment. Everything marked **OWNER/COUNSEL REVIEW REQUIRED** below needs a human legal
> decision before the pages can be treated as final. Nothing here was published except the edits listed in section 1.

Audit date: 2026-10-06. Implementation facts below were read from the code and (read-only) from production.

---

## 1. What was changed in the published pages (factual wording only)

| Where | Was | Now | Class |
|---|---|---|---|
| Terms intro | "By accepting an invitation to join, creating an account…" | "By creating an account, accepting an invitation, or otherwise using the Service" | A |
| Terms §1 title/body | "Invite-only, private service … private group … not open to the general public, not advertised" | "Access to the Service": by invitation or, while registration is open, by creating an account; the right to decline/suspend/revoke is kept verbatim | A+B (see B1) |
| Terms §2 ¶1 | "a private group … organize friendly prediction pools, keep score, and track who owes or is owed what" | Brohda publishes Game Posts; members make Picks, comment, Call BS; optional money Position between two members; wallet described as before plus Position results | A |
| Terms §2 ¶1–2 (r41 correction) | "wallet … **record-keeping tool only** — a running tally…"; "The Company is a facilitator of recordkeeping and organization only."; "The Company does not accept, hold, custody, transmit, or have access to any member's money at any time." | neutral factual description of the wallet, reserves, settlement, fee and withdrawals; the two claims and the "facilitator … only" lead-in removed; the "is not a bank…" sentence retained verbatim | A (factual) + B2/B3 |
| Terms §3 heading/body (r41 correction) | "3. All real-money transactions happen off-platform"; "Balances … reported and confirmed by administrators" | "3. Deposits and withdrawals happen outside the App"; "…confirmed by administrators, together with the results of settled Positions…" | A |
| Terms §3 | "deposits, withdrawals, entry fees, and payouts … between members, or between a member and a group administrator … payment methods the group chooses"; "group administrator" ×2 | "deposits and withdrawals … between a member and an administrator … payment methods listed in the App"; "an administrator" / "administrators" | A (allocation of responsibility untouched — B4) |
| Terms §4 | "participating in prediction pools or similar contests among your private group" | "using the Service — including making Picks and any optional money Positions with other members" | A (B5) |
| Terms §5 | "A pool may disclose a service fee retained from that pool's total contributions … flat service charge … group administrators" | Fee retained from the losing amount of a settled Position; rate shown before confirming; the rate at acceptance applies; compensates the Company; "service charge" ("flat" dropped — the fee is a percentage) | A (B6) |
| Terms §6 | invite-solicitation bullet; "any pool"; "a group administrator" | invite bullet removed; "any Market, Pick, Call BS, or Position"; "an administrator" | A (B7) |
| Terms §7 | "Group administrators … pool entries and outcomes … cancel pools" | "Administrators … wallet requests … the Service's records … correct errors or reverse recorded entries"; finality sentence kept verbatim | A (B8) |
| Privacy intro | "a private, invite-only platform"; "money between each other off-platform" | "a social network around real sporting events"; "money into or out of the App" | A |
| Privacy §1 | "pools you create or join, your picks, comments, **likes**, follows" | Picks (incl. changes before lock), comments, Call BS challenges, follows, notifications; separate **Wallet and money records** and **Administrative and security records** items | A — *see G2, G6: this text now names two things the old text didn't* |
| Privacy §2, §3, §6, §9 | "group administrators", "pool result", "leaderboard", "group's historical ledger" | "administrators", "a graded Pick, a Call BS result", Service's ledger | A |
| Privacy §4 | "a social app for a private group … entries, likes, comments, leaderboard stats … visible to members of your group" | What other signed-in members, members who picked the same Game, and logged-out visitors can see; **new paragraph: "Money is private to the people involved"** (locked rule, see §6) | A |

**Not changed on purpose:** the effective date of both documents ("July 22, 2026"), every disclaimer, the liability cap, indemnity,
governing law, termination, warranty, age limit, the "not collected / not sold / no ad cookies" promises, and the clause "This does not
affect any right you may separately have against another individual member with respect to money actually owed between you
off-platform" (§7).

---

## 2. Substantive legal items — OWNER/COUNSEL REVIEW REQUIRED

These are legal positions or allocations of risk, not product descriptions. Engineering has not changed their *substance*; where a
product fact they rest on is now untrue, that is stated.

- **B1 — Private / invite-only positioning (Terms §1, Privacy intro).** The old text said the Service is private, invite-only, not open to the
  public and not advertised. That is false today: production has `registration_enabled = true` and a public front door. The published text
  now says access is "by invitation … or, while registration is open, by creating an account". Whether the earlier positioning mattered
  to the legal analysis (gambling, money-transmission, consumer law) is a counsel question; the facts it rested on no longer hold.
- **B2 — Wallet balances, reserved funds, settlement, withdrawals and the platform fee: final legal characterization —
  OWNER/COUNSEL REVIEW REQUIRED.** The two published claims that "the wallet is a record-keeping tool only" and that "the Company does not accept,
  hold, custody, transmit, or have access to any member's money" were **removed** in the r41 correction because they no longer match the
  implementation (see section 2a for the exact before/after). They were replaced with neutral, factual wording of what the system does. **No legal
  characterization was substituted.** The final characterization of each of the following is for the owner and qualified counsel to decide, and
  nothing in the published Terms should be read as having decided it:
  1. member **wallet balances** (what they are, who they belong to, what the member is entitled to);
  2. **reserved funds** (holds placed on a balance for an open offer, an open Position or a withdrawal request);
  3. **settlement** of Positions inside the ledger (value moves between two members' balances according to the Market result);
  4. **withdrawals** (a request reserves funds; an administrator reviews, confirms and pays out off-platform);
  5. the **platform fee** (a percentage of the losing amount, snapshotted at acceptance, credited to a house account).
- **B3 — "Not … a bank, money transmitter, payment processor, escrow agent, broker, bookmaker, gambling operator, or party to any wager, bet, or
  contest between members" (Terms §2) — OWNER/COUNSEL REVIEW REQUIRED.** This owner-authored sentence is **retained verbatim**, on purpose: the
  correction removed only the objectively obsolete factual claims, and removing (or restating) a legal classification is not an engineering
  decision. Note the tension for counsel: Brohda now reserves balances, settles Positions on game outcomes in its own ledger and takes a fee.
  Engineering has added no new classification anywhere (no escrow, custodian, money transmitter, sportsbook, financial institution or
  broker language). A unit test guards that these words appear in the Terms only inside this one retained sentence.
- **B4 — Allocation of responsibility for off-platform transfers (Terms §3, §9, §10).** Wording was written for a private group where members
  paid each other. Now deposits/withdrawals are between a member and the Company's administrators. Sentences such as "Disputes about
  whether a real-world payment was actually sent or received are between the members involved" no longer describe the parties. Only
  the nouns "group administrator" → "administrator" were changed; the allocation itself needs a decision.
- **B5 — Legality and eligibility (Terms §4).** The user remains solely responsible for the legality of "using the Service — including … optional
  money Positions". The Service is now public and may be reachable from many jurisdictions. Whether this wording, an age/jurisdiction
  gate, or availability restrictions are appropriate is for counsel. (Engineering has not invented any restriction.)
- **B6 — Fee characterization (Terms §5).** "It is a service charge, not a wager, stake, or bet placed by the Company" is retained. The
  fee is a percentage of the losing amount (production setting `p2p_fee_bps` = 100 → 1%), snapshotted at acceptance. "flat" was removed
  because it was factually wrong; whether the characterization stands is a legal call.
- **B7 — Conduct obligations (Terms §6).** One obligation (do not solicit non-trusted invitees/the general public) was removed because the
  premise (private group) is gone. Conduct coverage overall is thin — see section 3.
- **B8 — Administrator authority and finality (Terms §7).** "Their good-faith decisions regarding the App's records are final" is retained;
  the scope sentence was updated to current functions. Needs confirmation that the scope and finality language fit a public product
  where administrators are Company staff.
- **B9 — Liability cap (US$100), indemnity, warranty disclaimer (Terms §8–10).** Unchanged. Referencing "off-platform payment made or received
  between members" is now incomplete (see B4).
- **B10 — Governing law and exclusive jurisdiction: Costa Rica (Terms §13).** Unchanged. Suitability for a public consumer product is a
  counsel question.
- **B11 — Effective date, notice and acceptance record.** Both documents still say "Effective July 22, 2026" although their text changed.
  Terms §12 says material changes are "made available in the App". Registration requires an "I accept" checkbox
  (`acceptedTerms`), but **acceptance is not stored or versioned** (no column/record), and existing members are not re-prompted.
  Counsel should decide the effective date, whether this is a "material change", and whether to add acceptance records/re-acceptance.

### 2a. r41 correction — exact before / after (Terms §2 and §3)

**Before (as published on `main`):**

> The Service provides software tools that let a private group of people who know each other organize friendly prediction pools, keep score, and
> track who owes or is owed what within the group. The Service includes an in-app "wallet" balance that is a **record-keeping tool only** — a running
> tally of amounts group members and administrators have told the App they sent or received using payment methods entirely outside the App.
>
> **The Company is a facilitator of recordkeeping and organization only. The Company is not a bank, money transmitter, payment processor, escrow
> agent, broker, bookmaker, gambling operator, or party to any wager, bet, or contest between members.** The Company does not accept, hold, custody,
> transmit, or have access to any member's money at any time.
>
> *3. All real-money transactions happen off-platform*

**After (this branch):**

> brohda. is a social network built around real sporting events. brohda. publishes the games ("Game Posts"); members make Picks on them, comment, and can
> challenge one another with "Call BS". Members do not create games or competitions. Where it is enabled, the Service also lets two members agree an
> optional money Position on opposing Picks. The Service includes an in-app "wallet" balance. Where the optional money functionality is enabled, a
> member may add funds to their wallet balance and may request a withdrawal, in each case using payment methods outside the App and subject to an
> administrator's review and confirmation. A member who makes or accepts an offer commits part of their wallet balance to that Position: the Service
> records the amount as reserved while the Position is open and, once the Market is decided, settles the Position by updating the wallet balances of
> the two members according to the Market's result. If a Position is voided, the reserved amounts are released. The Service may deduct a platform fee as
> described in Section 5. A money Position is private to the two members involved and to authorized administrators.
>
> **The Company is not a bank, money transmitter, payment processor, escrow agent, broker, bookmaker, gambling operator, or party to any wager, bet, or
> contest between members.** *(retained verbatim — see B3)*
>
> *3. Deposits and withdrawals happen outside the App*  (and: "Balances shown in the App reflect what has been reported and confirmed by administrators,
> together with the results of settled Positions, …")

What was removed: "record-keeping tool only"; "The Company is a facilitator of recordkeeping and organization only."; "The Company does not accept, hold,
custody, transmit, or have access to any member's money at any time."; "All real-money transactions happen off-platform" (settlement happens inside the
ledger, so that heading was itself inaccurate). What was **not** added: any statement about custody, ownership of funds, escrow, gambling status, licensing or
regulatory treatment. Each fact in the new wording was checked against the implementation (deposit/withdrawal requests reviewed by an administrator;
stake reserved at proposal and at acceptance; settlement by balance update from the Market result; VOID releases both holds with no fee; fee taken from
the losing amount; money Positions visible only to the two members and super-admin operators).

**Left unresolved on purpose** (the sentence "The Service only records that an administrator has confirmed such a transfer occurred; it does not
initiate, process, guarantee, or reverse any transfer" in §3, the §3 allocation of disputes, §9/§10 references to off-platform payments "between members",
and the §5 characterization of the fee) — all part of B2–B6 above.

### 2b. Deferred to the later legal/privacy cleanup milestone (explicitly out of scope here)

formal conduct policy · Terms version acceptance/history · re-consent on material Terms changes · profile-field disclosures (G1) · Sentry disclosure (G3) ·
Resend disclosure (G4) · withdrawal-destination wording (G5) · deletion vs. append-only ledger reconciliation (G9) · audit-log IP discrepancy (G7).

---

## 3. Conduct and moderation — what the Terms cover today

| Topic | In Terms? | Implementation / note |
|---|---|---|
| Harassment | **No** | — |
| Threats | **No** | — |
| Spam | **No** | comments are rate-limited in code |
| Abuse of the Service | Partly (§6: manipulate outcomes, interfere with others' use, circumvent security, fraud/laundering) | — |
| Prohibited content | **No** | — |
| Moderator removal authority | **No** | moderators (admin/super admin) can remove comments; the Rules page says so and says "what isn't allowed … is covered in the Terms" — **the Terms do not cover it, so that cross-reference currently points at nothing** |
| Account suspension/termination | Yes (§11; also §1) | — |

This milestone did not implement moderation and did not publish new conduct language. The **proposed draft below is for review only** and
is deliberately short. Until it is reviewed, the Rules sentence that defers to the Terms is a known mismatch (P1).

### Proposed conduct section — DRAFT — OWNER/COUNSEL REVIEW REQUIRED

> **Conduct and content.** Be respectful. You may not use the Service to harass, threaten, or abuse other people; to post spam, scams, or
> content that impersonates someone else; to post unlawful content or other people's private information; or to post content that is
> hateful or that targets people for who they are. We may remove content, limit features, or suspend or end an account at our
> discretion, with or without notice, including for conduct we consider harmful to members or to the Service. If you see content that
> breaks these rules, contact support@brohda.com.

---

## 4. Privacy — implementation findings that the policy does not (fully) disclose

Per the brief these are **reported, not silently normalised**. Items marked ✱ are *also now mentioned in the published text* because they
describe data the Service already stores about activity the page already listed; counsel should confirm that wording.

- **G1 — Optional profile fields.** `user_profiles` stores `pronouns`, `gender`, `bio` (each with a "show on profile" toggle) and
  `analytics_timezone`. The policy lists only email, display name, username and photo. The new §4 says "any optional profile details you
  choose to show" without naming them.
- **G2 ✱ — Pick change history.** `prediction_revisions` keeps each change to a Pick before it locks. The text now says "(including any
  changes you make to them before they lock)".
- **G3 — Error and performance monitoring (Sentry).** `@sentry/nextjs` is initialised on client and server with `NEXT_PUBLIC_SENTRY_DSN`
  set in production; unhandled errors are captured and 10% of traces sampled. Default Sentry settings (no explicit PII flag). Not
  named in the policy (§5 lists "infrastructure providers … including a hosting/database/authentication provider and a sports-data
  provider" — non-exhaustive).
- **G4 — Email delivery provider (Resend).** `RESEND_API_KEY` is set in production; Supabase Auth's SMTP relay uses it for account email
  (password reset etc.). The member's email address and message content are processed by that provider. Not named.
- **G5 — Withdrawal payout destination provided by the member.** `wallet_requests.note` carries the member's payout destination (a
  handle or wallet address) for withdrawals, and it is copied to the ledger entry. Privacy §2 says destination details "are provided by
  administrators … not collected from you". That is true for deposit instructions, **not** for withdrawals. Unchanged in the text.
- **G6 ✱ — Sign-in attempt records.** `rate_limits` counts attempts per `login:<identifier>` (and per user for comments and money
  offers). The text now says "security-related records such as sign-in attempts".
- **G7 — IP address.** The policy says device/log data includes IP address. `audit_logs.ip` exists but **no call site populates it**
  (always null); IP exposure is via the hosting/database providers' request logs.
- **G8 — Named processors.** Hosting (Vercel), database/auth (Supabase), sports data (API-NFL), error monitoring (Sentry), email (Resend)
  are described generically.
- **G9 — Deletion vs. retention.** Policy: contact us to request deletion. Code: account closure removes name, username and photo, the
  email can never register again, and the wallet ledger is append-only (a member with ledger history cannot be hard-deleted). Counsel should
  confirm the stated rights match this.
- **G10 — Terms acceptance not recorded** (also B11).

### Proposed additions — DRAFT — OWNER/COUNSEL REVIEW REQUIRED

> **Information we collect (additions).** Optional profile details you choose to add (such as pronouns, gender, a short bio) and your
> time zone. When you request a withdrawal, the payout details you provide (for example a payment-app handle or wallet address).
>
> **Service providers (replace the generic sentence).** We use Vercel (hosting), Supabase (database and sign-in), API-NFL (sports data),
> Sentry (error and performance monitoring), and Resend (email delivery). They process data on our behalf. We do not sell your information
> and do not share it with advertisers.

---

## 5. Locked monetary-privacy rule — what the page now says, and what the implementation proves

Published (Privacy §4): *"an offer or Position between two members — whether it exists, its amount and status, its settlement, and its
effect on either wallet — is visible to those two members and to authorized administrators, and money notifications are sent only to the two
members involved. No other member can see it."* plus an explicit note that administrators and infrastructure operators can access stored data.

Evidence (not a promise beyond it):
- RLS on the money tables: authenticated clients are SELECT-only with participant-own policies plus super-admin select-all; anon none.
  Verified in production and by `tests/integration/monetary-capability-gating.test.ts` (a bystander and an anonymous client read none of
  proposals, Positions, settlements, reservations, ledger rows or balances, and cannot write).
- A third member on the same Market sees no amount, offer, Position or money indicator, with money on or off
  (`tests/e2e/monetary-capability-gating.spec.ts`, privacy scenario).
- The text deliberately does **not** claim encryption or that no one at the Company can see it.
- The disclosure does not depend on whether the feature is currently on: it is written "where optional money Positions are or have been
  enabled", because stored historical records and prior transactions exist regardless of the UI flag (production holds 3 Positions and 3
  settlements today).

---

## 6. Definitions across Rules / Terms / Privacy / product UI

| Term | Rules | Terms | Privacy | UI |
|---|---|---|---|---|
| Game Post | Brohda publishes it; members can't create/edit | "Game Posts … Members do not create games or competitions" | (n/a — "Game") | Game Post card |
| Market / Pick | A Pick is one of a Market's two sides | "make Picks"; "any Market, Pick, Call BS, or Position" | "your Picks" | team / spread / Over-Under choices |
| Call BS | head-to-head, one accepted per Market | "Call BS" | "Call BS challenges / record" | Call BS action |
| Prediction record | correct ÷ (correct + incorrect) | — | "prediction record (the share of your decided Picks that were correct…)" | Profile line |
| VOID | cancelled game, tied Moneyline, push → Market voided | — | — | "Result: Void" |
| Money / Position | optional; Position between two members | "optional money Position" | "Wallet and money records … offers and Positions" | Put money on it (when enabled) |
| Wallet | — (Rules avoid it) | in-app wallet balance; reserves; settlement; fee (neutral factual description) | wallet ledger | Wallet (when visible) |

Remaining contradictions: the Rules defer to the Terms for what is not allowed (section 3); Terms B3–B4 describe the Company's role in
money in language that predates the current ledger/holds/fee model (the B2 factual claims were corrected in r41).

---

## 6a. Zero-leak search — classification of every hit

Search: `pool(s)`, `pool organizer`, `entry`, `entry fee`, `owes`, `owed`, `leaderboard`, `likes`, `group`, `invite` across
`app/terms`, `app/privacy`, `/rules` content, `/how-it-works` (redirect), landing and legal components.

| Hit | Where | Classification |
|---|---|---|
| "invited" | Privacy §1 ("registered or were invited with") | Legitimate — the invitation path still exists |
| "invitation" | Terms intro, §1 | Legitimate — same |
| "entries" | Privacy §1 ("wallet ledger entries"), Terms §7 ("recorded entries") | Legitimate — ledger entries |
| "owed … off-platform" | Terms §7 last sentence | Legitimate legal text — B-class, retained |
| `pool`, `entry fee`, `owes`, `leaderboard`, `likes`, `group`, `invite-only` | — | **No hits remain**; guarded by `tests/unit/legal-copy.test.tsx` |
| `/how-it-works` | redirect to `/rules` | No standalone copy |
