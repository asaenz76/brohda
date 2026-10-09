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

### 2b. Handled in the r42 cleanup milestone (see sections 3, 4 and 7)

Conduct policy (section 3) · Terms/Privacy version identifiers and an append-only acceptance record + a deliberate re-consent switch (section 7) ·
profile-field, Sentry, Resend and withdrawal-destination disclosures, the deletion-vs-ledger reconciliation and the audit-log IP discrepancy
(section 4). Every item below is still **OWNER/COUNSEL REVIEW REQUIRED**; engineering corrected facts only.

---

## 3. Conduct and moderation — what the Terms now say (r42)

| Topic | In Terms? | Implementation behind it |
|---|---|---|
| Harassment, threats, abuse | **Yes** (§6) | no automated detection; handled by moderators/admins |
| Content attacking people for who they are | **Yes** (§6) | same |
| Spam, scams, impersonation | **Yes** (§6) | comments are rate-limited in code (not described in the Terms) |
| Unlawful content / others' private information | **Yes** (§6) | same |
| Moderator removal authority | **Yes** (§6: "We and our moderators may remove content, including comments…") | moderators (admin / super admin) can remove comments (`removePostCommentAction`) |
| Account suspension/closure | **Yes** (§6 points to §11; also §1, §11) | a super admin can deactivate an account (`setUserActiveAction`) |
| Reporting | **Yes** — "tell us at support@brohda.com" | there is **no in-app report button**; the Terms promise nothing beyond email |

The Rules page's sentence "What isn't allowed on Brohda is covered in the Terms." now points at something (Terms §6; guarded by a unit test).

**Deliberately not stated** (so the Terms promise nothing the product does not do): strikes, warnings, appeals, response times, automated
enforcement, limiting features (the earlier draft said "limit features"; there is no such tool, so it was removed), shadow-banning, any
guaranteed review of reports.

**OWNER/COUNSEL REVIEW REQUIRED (B-class):** the substance of the conduct list (what is prohibited, and the "hateful or targets people for who
they are" line, which was reduced to "attacks people for who they are"), the authority to remove content and to suspend or close accounts "at
our discretion, with or without notice", and whether a public product needs a notice-and-takedown / reporting / appeals process. Engineering
wrote only the minimum that matches the tools that exist.

---

## 4. Privacy — implementation findings, and what the policy now says (r42)

Every item was audited against the code, and the policy now states the fact. The statements remain **OWNER/COUNSEL REVIEW REQUIRED** as legal
text; engineering only made them match the implementation.

| # | Finding | Published now |
|---|---|---|
| G1 | `user_profiles` stores optional `pronouns`, `gender`, `bio` (each with a show/hide switch) and `analytics_timezone` | §1 names pronouns, gender and bio and their switches. **Not named:** `analytics_timezone` — it is a column defaulting to `America/Costa_Rica` that no application code reads or writes (verified), so it is not data the member provides; counsel to decide if it needs a line |
| G2 | `prediction_revisions` keeps each change to a Pick before it locks | named (r41) |
| G3 | Sentry initialised client + server in production, default settings, 10% trace sampling | "Error monitoring" paragraph: page address, browser/device, timing, error details; no name/email/account id configured; no session recording; **may incidentally contain identifiers** |
| G4 | Resend relays Supabase Auth account email; admins may also send notices | "Email" paragraph: receives the address and message content |
| G5 | `wallet_requests.note` carries the member's payout destination, copied to the ledger entry | §2 / §1: entered by the member, visible to the member and processing administrators, recorded on the ledger entry. **Tension for counsel:** the policy also says the Service never receives a "bank account number" — a payout destination can be a handle or wallet address; the wording says "payment-app handle or wallet address" only |
| G6 | `rate_limits` counts sign-in attempts per identifier | "security-related records such as sign-in attempts" (r41) |
| G7 | `audit_logs.ip` exists but no call site populates it | **Decision: not populated, not collected.** The policy attributes IP/browser/timestamp logging to "our hosting and infrastructure providers" and claims no IP collection of our own |
| G8 | Providers: Vercel, Supabase, API-Sports, Sentry, Resend | named in §5. **r43:** the sports-data provider is named "API-Sports" (was "API-NFL") because NBA and NHL data come from the same vendor's basketball and hockey products; a factual correction only — counsel to confirm the processor naming |
| G9 | Deletion vs. append-only ledger | "deletion" removed from the rights sentence; new "Closing your account" paragraph states exactly what closing removes (name, username, photo, optional profile details; email stays reserved) and what is kept (Picks and comments as "Deleted User", Call BS results, wallet and money ledger, admin-action records that may keep the prior name/username, the acceptance record) |
| G10 | Terms acceptance was not recorded | recorded from r42 on (section 7); existing members have no row and none was invented |

**OWNER/COUNSEL REVIEW REQUIRED:** whether "contact us for access or correction" is the right rights statement for the jurisdictions the public
product reaches (the deletion right was removed, not replaced — the policy no longer promises deletion on request); whether retaining the ledger,
audit records and the acceptance record after closure, and keeping the email permanently reserved, is disclosed and justified adequately; the
processor list and the Sentry/Resend descriptions; and the timezone gap above. Other jurisdiction-specific content (GDPR/CCPA etc.) was not
added and is not claimed.

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

---

## 7. Version identifiers, acceptance record and re-consent (r42) — OWNER DECISION REQUIRED

- `lib/legal/documents.ts` is now the one place for each document's `version` and `effectiveDate`; both pages render the date from it.
- `legal_acceptances` (append-only: UPDATE/DELETE are refused for every role) stores which version a member accepted, when, and from where
  (`register` | `invitation` | `reconsent`). Registration and invitation acceptance record both documents. **No backfill:** members who joined before this
  table have no row, and none was invented.
- Re-consent is a deliberate switch: `platform_settings.legal_reconsent_required` (default empty). When it lists a document, every signed-in
  member without an acceptance of the **current** version is routed to `/accept-terms` before continuing. Copy edits never trigger it. It was **not**
  turned on, in any environment.
- **Open question for the owner/counsel — NOT chosen by engineering:** both documents still carry "Effective July 22, 2026" (version `2026-07-22`),
  although their text has changed several times since (r39–r42). Decide (1) the effective date and version of the current text; (2) whether the
  change is "material" and existing members must re-accept (turn on the switch only then); (3) what the Terms §12 notice should be. Changing the
  version/date is a one-file edit; enabling re-consent is one settings value.

---

## 8. Money-capability gating of the legal pages (r44) — OWNER/COUNSEL REVIEW REQUIRED

Rules already hid money copy when `monetary_p2p_enabled = false`. Terms and Privacy now follow the **same single capability** (no second flag), composed at
section level from one derived `LegalMoneyMode` (`lib/legal/money-mode.ts`, `components/legal/TermsDocument.tsx`, `PrivacyDocument.tsx`):

| Mode | When | What the pages say |
|---|---|---|
| `active` | money ON | The complete documents — **text-identical to before** (verified by rendering the old and new pages and comparing). |
| `retained` | money OFF **and** financial records exist (or the check can't be read) | No current-feature copy (offers, funding, settlement mechanics, the fee, who sees an active Position). The disclosure the records require is **structurally separated**: Terms has one titled section, "Retained wallet records and existing balances" (what is kept; an existing balance is withdrawn through an administrator; third-party-transfer responsibility; balances reflect administrator-confirmed records), and Privacy has one titled section, "Financial records we still hold" (what is kept, withdrawal-destination handling, who can see it, permanent retention). Both sections exist **only** in this mode and nowhere else in the document do the pages describe wallets, funding, offers or Positions. |
| `free` | money OFF **and** no financial record was ever stored | No money language at all (only the Company's classification disclaimer, below). |

"Records exist" is a **fact** (any row in `wallet_transactions`, `wallet_requests`, `monetary_positions`, `monetary_proposals`, or a user balance > 0), not a flag. Fail-safe is
deliberately asymmetric: an unreadable *setting* hides the consumer money copy; an unreadable *records check* keeps the disclosure — the page never claims "no financial data" on a guess.
Production holds 3 Positions / 3 settlements and ledger history, so production renders `retained` when money is off.

Terms **and Privacy** numbering and "Section N" cross-references are derived from the sections actually shown (a reference to a hidden section throws in tests and cannot ship).

**Where money wording may remain when money is OFF (r50 classification — every other occurrence is a defect, pinned by `tests/unit/legal-money-gating.test.tsx`):**

| Page / section | Remaining wording | Class |
|---|---|---|
| Terms "What the Service is — and is not" | The Company is not a bank, money transmitter… (+ pointer to the retained-records section in `retained`) | REQUIRED LEGAL DISCLOSURE (owner-locked wording) |
| Terms "Retained wallet records and existing balances" (`retained` only) | the retained-records disclosure | REQUIRED RETENTION DISCLOSURE |
| Terms "Your conduct" | "money laundering" (all modes); false information about a withdrawal/payment (`retained` only) | generic conduct rule / REQUIRED RETENTION |
| Terms "Administrator discretion" (`retained`) | authority over retained records and withdrawal requests | REQUIRED RETENTION |
| Terms "Limitation of liability" / "Indemnification" | boilerplate "loss of money" (all modes); off-platform payment/dispute clauses (`retained` only) | REQUIRED LEGAL |
| Terms "Termination" (`retained`) | closing an account does not erase the wallet records | REQUIRED RETENTION |
| Privacy "What we do not collect" | no card / bank / payment-app credentials or government ID | generic data-minimisation statement (not a feature description) |
| Privacy "Financial records we still hold" (`retained` only) | the retained-records disclosure | REQUIRED RETENTION DISCLOSURE |
| Privacy "Your choices" (`retained`) | pointer: financial records described in Section N are kept after closing | REQUIRED RETENTION |
| Rules | none (only the Market name "Moneyline") | — |

**Flagged for owner/counsel (engineering changed wording only to remove current-feature copy; no legal classification was added):**
1. The Company's classification disclaimer ("not a bank, money transmitter, payment processor, escrow agent, broker, bookmaker, gambling operator, or party to any wager…") is shown
   in **every** mode, including `free` — it is a legal statement, not feature copy; whether to drop it in the clean state is a counsel decision.
2. The `retained` Terms §3 is new wording assembled from existing sentences (it deliberately avoids saying the feature is unavailable). Counsel to confirm it is the right
   statement of obligations for members with existing balances and for withdrawal rights.
3. Limitation of liability and indemnity keep their "off-platform payment / dispute over money" clauses in `retained` (they cover withdrawals and history) and drop them in `free`.
4. Wind-down: nothing needed to recover an existing balance is hidden — the wallet remains reachable for balance-holders (`canSeeWallet`), and the legal pages keep the withdrawal process
   in `retained`.

**Owner instruction (2026-10-07):** the retained classification language (e.g. "The Company is not a bank, money transmitter…") is not to be rewritten by engineering; the capability-gating implementation stays as built. All substantive legal classification remains OWNER/COUNSEL REVIEW REQUIRED.

---

## 9. Sponsored Game Posts (r52) — OWNER/COUNSEL DECISIONS REQUIRED

Engineering did **not** change the Terms or the Privacy Policy for sponsorship (as instructed). The items below need an owner/counsel decision before the feature is turned ON in production:

1. **Terms of service for sponsors** (a commercial agreement: pricing, payment, approval discretion, refund policy, takedown, content warranties, indemnity). None exists; sponsors are onboarded manually by Super Admin. The refund policy is deliberately *not* encoded — refunds are an explicit manual step.
2. **Advertising disclosure wording.** Members see "Sponsored · Presented by …" (a plain-language label). Confirm it satisfies the advertising-disclosure rules that apply where Brohda operates.
3. **Promotion disclosure wording** shown on the Post: "This promotion is run by the sponsor, not by Brohda. Brohda does not take entries, choose winners, hold prizes or deliver them. See the official rules for who is eligible and how it works." (`PROMOTION_DISCLOSURE`). Counsel to confirm, and to decide whether sponsor promotions need any jurisdictional restrictions or registration — Brohda takes no role in them by design.
4. **Privacy.** New processing: sponsor contact details (admin-entered), and internal impression/click records tied to a signed-in member (never shown to sponsors; aggregate-only reporting is planned). The Privacy Policy currently lists none of this. Decide whether it must be disclosed (what is collected, purpose, retention) before launch.
5. **Third-party click-outs.** Following a sponsor link leaves Brohda; the Terms already say third-party services have their own terms, but counsel may want an explicit sentence for sponsored links.
6. **Classification.** Nothing here changes "The Company is not a bank, money transmitter…" or any monetary language; sponsorship revenue is advertising revenue, separate from player money.


## 10. Sponsor accounts (identity milestone)

Engineering built the *mechanism* for Sponsor Terms (versioned, per-account acceptance record) and wrote **no legal text**. Counsel/owner decisions needed before launch: (1) Sponsor Terms of Service and the page to publish them on (then set `CURRENT_SPONSOR_TERMS` in `lib/sponsor/terms.ts`); (2) the media/advertising agreement (content warranties, takedown, indemnity); (3) how the Privacy Policy describes Sponsor business-contact data (business email, contact name, phone) and that Sponsors are separate from Members; (4) refund and cancellation language for a suspended/disabled Sponsor with a paid, live campaign; (5) who is responsible for sponsor-run promotions (already disclosed on the Game Post) and whether the Sponsor Terms must repeat it.
