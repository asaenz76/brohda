# Milestone 6 Readiness / Decision Gate

**Status**: This document is the final readiness/decision gate converting every unresolved Milestone 4/5 prerequisite into a concrete, auditable decision. **This is not Milestone 6 implementation.** No real order was placed, no wallet was created or funded, no provider order was signed, no private key or Session Key was created or stored, no trading mutation endpoint was called, nothing was deployed, and nothing was pushed in the production of this document. See §14 (Workspace integrity) and the companion completion report for full production-safety confirmation.

**Companion documents** (all created alongside this one):
- [`docs/architecture/milestone-6-founder-decisions.md`](./milestone-6-founder-decisions.md) — explicit founder sign-off form (unchecked)
- [`docs/legal/milestone-6-counsel-brief.md`](../legal/milestone-6-counsel-brief.md) — briefing for qualified counsel
- [`docs/legal/milestone-6-legal-signoff.md`](../legal/milestone-6-legal-signoff.md) — checklist for counsel to complete
- [`docs/architecture/milestone-6-provider-readiness.md`](./milestone-6-provider-readiness.md) — Polymarket Builder/provider-side checklist

**Update**: Milestone 5.5 (`docs/architecture/execution-operational-safety.md`) has since built the operational safety infrastructure (kill switches, rollout cohorts, execution limits, provider health/circuit breaking, audit events, reconciliation) this document's own decision matrix (§6) named as `TECHNICAL IMPLEMENTATION REQUIRED` items. Their existence does not resolve any founder/counsel/provider blocker below — Milestone 6's implementation authorization status is unchanged by that milestone and remains governed by this document.

**Inputs consolidated (read in full for this document, not from memory)**: `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` (§7 Milestone 6, §9 Founder Decision Register), `docs/architecture/execution-architecture-gate.md` (Milestone 4, all 35 sections), `docs/security/execution-threat-model.md` (Milestone 4), `docs/architecture/simulated-execution.md` (Milestone 5, all 22 sections).

---

## 1. Baseline (STEP 1)

| Item | Value |
|---|---|
| Branch | `brohda/prediction-network-m0-m2` |
| HEAD | `92e99fb78fdd8eb95d89447c41ecd9df09eee994` (unchanged throughout this task) |
| Working-tree state | Matches the post-Milestone-5 state exactly at the time this document was first written — see completion report for full `git status` |
| Local migration head at original writing | `20260101000152` (Milestone 5's rate-limit remediation; no new migration was added by this readiness task itself) |
| Local migration head as of this re-verification (2026-09-17) | `20260101000160` — added by the intervening Milestone 5.5 (Execution Controls, Reconciliation & Operational Safety, `docs/architecture/execution-operational-safety.md`), which built operational-safety infrastructure only. None of migrations `20260101000153`–`20260101000160` touch custody, signing, wallets, KYC/AML/sanctions, jurisdiction, fees, or any other founder/counsel/provider blocker below — re-verified by inspection, not assumed |
| Milestone 4/5 docs read in full | `docs/architecture/execution-architecture-gate.md`, `docs/security/execution-threat-model.md`, `docs/architecture/simulated-execution.md`, `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` |
| No contradiction found | Milestone 5's own document (§22) explicitly states it introduced no real Order/Fill/Position/wallet/signing/custody record and remains blocked on the same Milestone 4 prerequisites — no conflict between the two documents |

No unrelated file was altered to produce this document. SHA-256 snapshots are recorded in §14.

---

## 2. Consolidated blocker list (STEP 2)

Every unresolved item found across the four source documents, deduplicated into one canonical list. "Source" cites where it was first raised; a blank cell means the item is introduced fresh by this document (not previously tracked as a named row).

| # | Blocker | Source | Prior status |
|---|---|---|---|
| 1 | Custody model | Gate §29 Decision #1 | BLOCKED — technical pref: no custody (Option C) |
| 2 | Wallet ownership | Gate §29 Decision #2 | BLOCKED — technical pref: user-owned Deposit Wallet |
| 3 | Signing model | Gate §29 Decision #3 | BLOCKED — technical pref: Session-Key delegation |
| 4 | Provider account model (does Brohda need any provider-side account beyond Builder?) | Gate §29 Decision #4 | OPEN |
| 5 | Builder registration (has Brohda actually registered?) | Gate §29 Decision #5 | OPEN — not performed (hard-stop rule) |
| 6 | Builder KYB (does becoming a Builder require entity-level KYB?) | Gate §2.2, §34 | OPEN — not stated in provider docs fetched in Milestone 4 |
| 7 | Fee model (actual Builder rate + any Brohda fee) | Gate §29 Decision #6 | FOUNDER DECISION not made; cap is provider-confirmed |
| 8 | Fee disclosure UX | Gate §29 Decision #7 | Architecturally LOCKED; no UI built |
| 9 | Geography / jurisdiction eligibility | Gate §29 Decision #8, roadmap OPEN #2 | OPEN |
| 10 | Legal classification of Brohda's role | Gate §5 #1, #12 | COUNSEL REQUIRED |
| 11 | KYC responsibility | Gate §29 Decision #10 | COUNSEL REQUIRED |
| 12 | AML responsibility | Gate §5 #7 | COUNSEL REQUIRED |
| 13 | Sanctions screening responsibility | Gate §29 Decision #11 | COUNSEL REQUIRED |
| 14 | Age requirements | Gate §29 Decision #12 | COUNSEL REQUIRED |
| 15 | Tax/reporting obligations | Gate §5 #11, #19 | COUNSEL REQUIRED |
| 16 | Provider restrictions (full jurisdiction list, enforcement mechanism) | Gate §2.4, §34 | Partially OPEN — see §3 below, now substantially improved by this document's own research |
| 17 | Secrets architecture (implementation) | Gate §31 item 8 | Architecturally LOCKED (§20); not implemented |
| 18 | Execution kill switch (implementation) | Gate §31 item 10 | Architecturally LOCKED (§15); not implemented |
| 19 | Rollout cohort (implementation) | Gate §31 item 11 | Architecturally LOCKED (§16); not implemented |
| 20 | Execution-specific rate limits (implementation) | Gate §31 item 12 | Decision made (fail-closed, §24); not implemented |
| 21 | Reconciliation (implementation) | Gate §31 item 9 | Architecturally LOCKED (§18); not implemented |
| 22 | Audit logging (implementation) | Gate §31 item 13 | Architecturally LOCKED (§21); not implemented |
| 23 | Provider outage handling (implementation) | Gate §31 item 15 | Architecturally LOCKED (§23); not implemented |
| 24 | Order idempotency (implementation) | Gate §31 item 14 | Architecturally LOCKED (§17); not implemented |
| 25 | Security review of real signing/secrets code | Gate §31 item 16 | Cannot happen until code exists |
| 26 | Legacy wallet relationship | Gate §29 Decision #20, roadmap OPEN #5 | Architecturally LOCKED (no merge); migration *direction* still OPEN |
| 27 | User funding flow (deposit/withdrawal UX) | Gate §16, §25 | Conceptual only; not implemented |
| 28 | Incident response (operational runbook) | Threat model §10, roadmap Milestone 6 verification requirements | Not designed in operational detail |
| 29 | Support/recovery model | New — not previously tracked as its own row | OPEN (this document, §12) |
| 30 | Whether Polymarket's CLOB supports client-idempotent order IDs | Gate §17, §34 | OPEN — this document's research did not find this documented either (§3) |
| 31 | Whether Brohda entity-level KYB is required for Builder registration | Gate §2.2, §34 | OPEN — this document's research did not find this documented either (§3) |
| 32 | Crypto-visible UX principle (wallet word, chain name, etc. shown to consumer) | Roadmap OPEN #4 | OPEN — founder decision, not previously forced to an explicit answer |

No item was omitted because Milestone 5's simulation already exercised a similar concept (e.g. quote expiry, rate limiting, eligibility) — those items still require a fresh **real** decision because Milestone 5's simulated values were explicitly documented as non-authoritative placeholders (`docs/architecture/simulated-execution.md` §13/§20).

---

## 3. Current provider facts — re-verified (STEP 3)

**Research date**: 2026-09-16. All rows below were fetched live this task via `WebFetch`/`WebSearch` against `docs.polymarket.com`, `help.polymarket.com`, and `polymarket.com` — no cached or pre-training assumption was used as a substitute. No trading mutation endpoint was called; only public documentation pages were read. Where a fact could not be independently corroborated from a first-party source, it is marked **PROVIDER CONFIRMATION REQUIRED** rather than filled in with a plausible guess.

| Topic | Finding | Source | Date checked | Ambiguity |
|---|---|---|---|---|
| Session Keys | Deposit Wallet owner authorizes a separate EOA signer scoped to `CLOB`, `Combos`, or `All`; fixed **180-day** authorization, no shorter option; cannot withdraw funds; revocation immediately deactivates the key and asynchronously cancels open orders; "a dedicated migration flow from Safe Wallets and Proxy Wallets is planned" (not yet shipped) | `docs.polymarket.com/trading/session-keys` | 2026-09-16 | None material — matches Milestone 4's finding, reconfirmed unchanged |
| Wallet ownership | Deposit Wallet is the default for every account created on/after **May 4, 2026**; Proxy Wallet and Safe Wallet are legacy, no longer deployed for new accounts; EOA requires allowlisting and POL for gas; a beacon-proxy upgrade (**June 29, 2026**) lets Polymarket push security/feature updates to Deposit Wallets without changing the address (opt-out available, forfeits future upgrades) | `docs.polymarket.com/trading/wallets-auth` | 2026-09-16 | None material to Brohda's architecture choice (Option C still targets Deposit Wallet + Session Key) |
| Builder registration | Builder profile obtained via polymarket.com → Settings → Builders; a builder code is copied and must be attached to every order; the fetched pages describe **no account prerequisites, no KYB step, and no approval requirement for the base ("Unverified") tier** — "Start immediately with no approval required" | `docs.polymarket.com/programs/builders/overview`, `.../tiers` | 2026-09-16 | **Absence of a stated KYB requirement is not proof none exists** — the fetched pages are product documentation, not a compliance/legal source; Polymarket's own account-opening flow (email `builder@polymarket.com`) may surface requirements not published in docs. Classified **PROVIDER CONFIRMATION REQUIRED**, not resolved (§5) |
| Builder KYB | Not mentioned in any fetched page (`overview`, `fees`, `tiers`) | Same as above | 2026-09-16 | **OPEN — same as Milestone 4's own finding, still unresolved after fresh research.** The only way to close this with certainty is to begin the real (Unverified-tier, no-approval) registration flow and observe what it actually asks for, or to contact `builder@polymarket.com` directly — both are **founder/operational actions outside this document's scope**, per the hard-stop rule |
| Builder fees | Taker cap **0–100 bps**, maker cap **0–50 bps**, minimum increment **1 bp** — unchanged from Milestone 4. **New this task**: a builder may change its configured rate **at most once per 7 days**, with a **3-day advance-notice** requirement before a change takes effect, and cannot have multiple pending changes at once | `docs.polymarket.com/programs/builders/fees` | 2026-09-16 | None — this is a materially useful new operational constraint Milestone 4 did not find; it affects any future fee-change runbook (§8 row on fees) |
| Builder tiers / rate limits (Relayer) | **Unverified**: 100 Relayer txn/day, no approval. **Verified**: 10,000/day, manual approval via email with API key + use case + expected volume, reviewed "within a few business days." **Partner**: unlimited, enterprise negotiation, not detailed | `docs.polymarket.com/programs/builders/tiers` | 2026-09-16 | Unchanged from Milestone 4 |
| Account/wallet setup | Deposit Wallet is provisioned automatically for new accounts (post-May 4, 2026); Session Keys layer on top without transferring wallet ownership | `docs.polymarket.com/trading/wallets-auth` | 2026-09-16 | None |
| Order placement | Order struct fields confirmed: `salt`, `maker`, `signer`, `tokenId`, `makerAmount`, `takerAmount`, `side`, `signatureType` (0=EOA/1=Proxy/2=Safe/3=Deposit), `timestamp`, `metadata`, `builder`, `expiration` | `docs.polymarket.com/developers/CLOB/orders/create-order` | 2026-09-16 | Field list is slightly more detailed than Milestone 4's (adds `timestamp`, `metadata`); no material contradiction |
| Signing | EIP-712 typed-data signing, unchanged from Milestone 4 | Same | 2026-09-16 | None |
| Order lifecycle | `live`/`matched`/`delayed`/`unmatched`; trade statuses `MATCHED`→`MINED`→`CONFIRMED` (terminal) or `RETRYING`→`FAILED` (terminal); a marketable order **cannot be cancelled while in a pending delay window**; only the unfilled remainder of a partial fill can be cancelled | `docs.polymarket.com/concepts/order-lifecycle` | 2026-09-16 | Unchanged from Milestone 4 |
| Minimums/precision | `min_order_size` and `tick_size` are read live from the order-book endpoint (`GET /book?token_id=...`), not fixed platform-wide constants; a market stream emits `tick_size_change` events, so a cached tick size can go stale | Same as create-order page | 2026-09-16 | **New, material finding**: `tick_size` is not just per-market-at-a-point-in-time (as Milestone 5's simulation already correctly modeled) but can *change* for a live market mid-session — a future real order-submission adapter must re-fetch or subscribe to this, not cache indefinitely |
| Idempotent order IDs | **Not found.** No client-supplied idempotency-key field is documented on the order-creation endpoint; the API returns a server-generated `orderId` | `docs.polymarket.com/developers/CLOB/orders/create-order` | 2026-09-16 | **Still OPEN, same as Milestone 4.** Fresh research did not resolve this. Classified **PROVIDER CONFIRMATION REQUIRED** — must be confirmed directly (e.g. by inspecting the actual API response/error behavior on a duplicate submission in a controlled, low-value test once legally authorized) before Milestone 6's idempotency contract (gate doc §17) can be implemented with confidence rather than an assumption |
| Rate limits (general, non-Relayer) | **Found this task, not found in Milestone 4**: general REST **15,000 req/10s** (health check endpoint separately capped at 100/10s); CLOB general **9,000 req/10s**; balance/allowance GET **200/10s**, UPDATE **50/10s**; single order POST **5,000/10s burst, 120,000/10min sustained**; single order DELETE **5,000/10s burst, 120,000/10min sustained**; batch POST/DELETE **2,000/10s burst**, **21,000/15,000 per 10min sustained** respectively | `docs.polymarket.com/api-reference/rate-limits` | 2026-09-16 | A secondary, non-first-party aggregator source reported different sustained figures for single-order POST (36,000/10min vs. the 120,000/10min found on the official page) — **the official `docs.polymarket.com/api-reference/rate-limits` page is treated as authoritative here**; the discrepancy itself is noted so whoever implements Milestone 6 re-checks the live page rather than trusting either cached figure verbatim, since this page can change without notice |
| Geographic restrictions | **First-party, dated, itemized list obtained** (`help.polymarket.com`, article "Geographic Restrictions"): 39 named blocked countries including the United States, plus specific blocked Canadian provinces (Alberta, British Columbia, Ontario, Quebec) and Ukrainian regions (Crimea, Donetsk, Luhansk); a separate "close-only" list (Poland, Singapore, Taiwan, Thailand) where existing positions may be closed but no new order may be opened; VPN/circumvention explicitly prohibited under ToS §2.1.4 | `help.polymarket.com/en/articles/13364163-geographic-restrictions` | 2026-09-16 | **Enforcement mechanism not stated** ("a geoblocking system," no IP/KYC/wallet detail given) — this remains open. This list is also explicitly a **live, operator-maintained page, not a static legal text** — it must be re-fetched immediately before Milestone 6 launch, not cached from this document, since Polymarket can and does change it (the article itself describes several recent additions) |
| Provider terms for third-party builders | Not found in any fetched page this task (builder overview/fees/tiers pages do not cross-reference ToS obligations specific to builders) | — | 2026-09-16 | **OPEN**, same gap as Milestone 4 |
| Supported funding/collateral asset | **Resolved this task — see §4 below.** | `docs.polymarket.com/concepts/pusd`, `docs.polymarket.com/concepts/positions-tokens`, `help.polymarket.com` (exchange-upgrade article) | 2026-09-16 | Resolved; see §4 |
| Relayer requirements | Deposit Wallet trades are submitted gaslessly via Polymarket's own Relayer; Builder registration and Relayer usage are described together in the Builder overview page, with no separate "how to run your own relayer" path found | `docs.polymarket.com/programs/builders/overview` | 2026-09-16 | Consistent with Milestone 4; no new gap found |
| Withdrawal/redemption model | Withdrawal is `POST /withdraw` (wallet address, destination chain, token, recipient) plus a status-polling endpoint; pUSD is unwrapped to USDC via a "Collateral Offramp" and swapped through a Uniswap v3 pool when leaving Polymarket; no Polymarket-side fee to deposit/withdraw USDC, though intermediaries (exchanges, bridges, wallets) may charge their own | `docs.polymarket.com/trading/bridge/withdraw` (page title confirmed via search; not independently re-fetched with WebFetch this task — **flag below**) | 2026-09-16 | **This specific page was found via `WebSearch` summary, not independently re-fetched with `WebFetch` this task** — treated as **lower-confidence** than the other rows in this table for that reason, and explicitly flagged **PROVIDER CONFIRMATION REQUIRED** before any Milestone 6 withdrawal-adjacent code is written, even though Brohda's own recommended architecture (Option C) never touches withdrawal at all (the user withdraws directly from their own Deposit Wallet, never through Brohda) |

**Remaining provider unknowns** (carried forward, not resolved by this task): (1) whether Builder registration requires Brohda-entity KYB, (2) whether the CLOB supports client-idempotent order IDs, (3) the exact geofencing enforcement mechanism, (4) whether third-party-builder-specific ToS obligations exist beyond the general ToS. All four are classified **PROVIDER CONFIRMATION REQUIRED** in the decision matrix (§8).

---

## 4. Collateral naming discrepancy — RESOLVED (STEP 4)

Milestone 4 flagged an unresolved discrepancy between "pUSD" and "USDC" terminology (gate doc §1). This task's fresh research resolves it:

- **Actual settlement/collateral asset**: **pUSD** ("Polymarket USD") — a standard **ERC-20** token on **Polygon**, 6 decimals, backed 1:1 by USDC with onchain-enforced backing ("no algorithmic peg, no fractional reserve" — `docs.polymarket.com/concepts/pusd`).
- **Chain**: Polygon (unchanged from Milestone 4's finding).
- **Token standard**: pUSD itself is ERC-20; the YES/NO outcome tokens it backs are ERC-1155 under the Gnosis Conditional Token Framework (`docs.polymarket.com/concepts/positions-tokens`) — these are two different tokens serving two different roles, not competing names for the same thing.
- **Why different docs used different labels**: this is a **genuine platform evolution, not inconsistent documentation**. Polymarket migrated its trading collateral from USDC.e to the new pUSD wrapper in a platform-wide exchange upgrade on **April 28, 2026** (`help.polymarket.com`, "Polymarket Exchange Upgrade: April 28, 2026" — existing users' USDC balances were converted to pUSD 1:1 with no fee; new CTF Exchange V2 contracts were deployed; v1 client libraries stopped working against the new contracts). Milestone 1's own audit notes and Milestone 4's own citations predate this upgrade in spirit (both were written after 2026-09-16 per their own dating, i.e. after the upgrade — meaning the "USDC" terminology Milestone 4 flagged as "more commonly associated with Polymarket historically" was accurate for the *pre-upgrade* platform, not a documentation error). USDC (specifically bridged USDC.e) remains the deposit/withdrawal-facing asset; pUSD is purely the internal trading-collateral wrapper introduced by the upgrade.
- **Should Brohda expose any of this to consumers?** **No.** This confirms, rather than complicates, the roadmap's own existing product-vocabulary decision (§10: "token," "settlement token" are internal-only vocabulary) and Milestone 5's own precedent of never surfacing provider-specific asset names in consumer copy. A user should see "amount," "balance," "add funds" — never "pUSD," "USDC.e," or "wrap/unwrap." This requires no new decision; it is already covered by the existing locked vocabulary principle.

**Classification: PROVIDER CONFIRMED.** No further ambiguity remains on the asset identity/chain/standard question. The *migration mechanics themselves* (Offramp, Uniswap v3 swap on withdrawal) are noted in §3 as lower-confidence pending an independent re-fetch, but that does not reopen the naming question — the naming question is closed.

---

## 5. Builder registration requirements (STEP 5)

| Item | Finding | Classification |
|---|---|---|
| Whether Brohda must register as a Builder | Yes — a builder code is required on every order for fee attribution and gasless relayer access; there is no documented way to route third-party orders through Polymarket's CLOB without one | **PROVIDER CONFIRMED** (the requirement to register exists; the registration act itself has not been performed, per the hard-stop rule) |
| Current onboarding process | polymarket.com → Settings → Builders → copy builder code; attach it to every order; Unverified tier requires no approval | **PROVIDER CONFIRMED** |
| Account prerequisites | Not documented beyond having a Polymarket account | **OPEN** |
| KYB requirements | Not mentioned in any fetched page (overview, fees, tiers) | **OPEN — same gap as Milestone 4, unresolved by fresh research (§3)** |
| Review/approval requirements | None for Unverified tier ("start immediately"); Verified tier requires emailing `builder@polymarket.com` with API key, use case, expected volume, reviewed "within a few business days"; Partner tier requires separate, undetailed negotiation | **PROVIDER CONFIRMED** |
| Fees | Taker 0–100 bps / maker 0–50 bps, 1 bp increment, builder-configurable within cap; rate changes limited to once per 7 days with 3-day advance notice | **PROVIDER CONFIRMED** (cap and change-cadence); **FOUNDER ACTION REQUIRED** (choosing the actual rate) |
| Builder credentials | A "builder code," described as attached per-order; the specific credential-issuance/storage mechanics (is it a static string, a signed key, rotatable?) are not detailed in the fetched pages | **OPEN** |
| Builder code/attribution | Embedded directly in the signed order struct (`builder`, bytes32), onchain and immutable once signed | **PROVIDER CONFIRMED** |
| Technical prerequisites | Attach builder code to every order; use Polymarket's relayer for gasless submission; submit via CLOB; monitor the Builder Leaderboard (up to 24h attribution lag) | **PROVIDER CONFIRMED** |
| Geographic restrictions on becoming a Builder itself | Not mentioned in fetched pages | **OPEN** |

**Overall classification for "may Brohda begin registering as a Builder today": FOUNDER ACTION REQUIRED**, contingent on legal counsel's answer to whether Builder-fee revenue changes Brohda's regulatory role (counsel brief Q3) — registering and earning builder-fee revenue before that legal question is answered would be premature even though the Unverified tier itself requires no approval. **No account was created and no registration was submitted by this task**, per the explicit instruction.

---

## 6. Decision matrix with authority (STEP 8)

Statuses used, exactly as specified: `READY`, `FOUNDER APPROVAL REQUIRED`, `COUNSEL REQUIRED`, `PROVIDER CONFIRMATION REQUIRED`, `VENDOR DECISION REQUIRED`, `TECHNICAL IMPLEMENTATION REQUIRED`, `BLOCKED`. No item uses "TBD."

| Decision | Current recommendation | Authority required | Current status | Evidence required to close | Blocks implementation? | Blocks launch? | Reversible? | Config vs. invariant | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Custody model | Brohda never custodies user funds (Option C) | Founder, subject to counsel | **BLOCKED** | Founder decision doc §1 checked + counsel sign-off doc "custody reviewed" checked | Yes | Yes | Custody architecture is hard to reverse once launched; the *decision* itself is reversible pre-launch | True invariant once chosen (architecture) | See founder-decisions.md |
| Wallet ownership | User-owned Deposit Wallet | Founder, subject to counsel | **BLOCKED** | Same as above | Yes | Yes | Reversible pre-launch | True invariant once chosen | Depends on custody decision |
| Signing model | Provider-native Session Key delegation | Founder, subject to counsel | **BLOCKED** | Founder decision doc §1 checked + counsel "delegated signing reviewed" checked | Yes | Yes | Reversible pre-launch (no code exists yet) | True invariant once chosen | Directly triggers counsel brief Q2 |
| Crypto-visible UX | Minimal (no wallet/chain/token language) | Founder | **FOUNDER APPROVAL REQUIRED** | Founder decision doc checkbox | No (a UX principle can guide, not gate, initial coding) | Yes | Fully reversible (copy/UI change) | Configurable product policy (copy, visibility flags) | Already a strong roadmap default (§10); needs an explicit yes, not an inferred one |
| Initial jurisdiction | Not chosen by this document | Founder, then counsel | **FOUNDER APPROVAL REQUIRED**, then **COUNSEL REQUIRED** | Founder names ≥1 jurisdiction in founder-decisions.md + counsel signoff "jurisdiction approved" checked | Yes | Yes | Reversible (can expand/contract jurisdictions later) | Legal/compliance policy + configurable operational policy once bounded | See §7/§10 below |
| Geography enforcement mechanism | Server-side, provider-neutral eligibility pipeline (conceptual, gate doc §14) | Counsel (standard), Engineering (mechanism), possibly Vendor (geolocation) | **COUNSEL REQUIRED** then **TECHNICAL IMPLEMENTATION REQUIRED** | Counsel specifies required enforcement standard (IP-only / IP+attestation / IP+KYC) | Yes | Yes | Reversible | Legal/compliance policy (standard) + configurable operational policy (list) | Cannot be built correctly before counsel specifies the standard |
| Fee philosophy | Not chosen by this document | Founder | **FOUNDER APPROVAL REQUIRED** | Founder decision doc §1 checked with a stated philosophy (even if "$0 at launch") | No (a placeholder $0 config can exist to unblock coding) | Yes | Fully reversible (config) | Configurable product policy | See §18 below; must never be a code constant even once chosen |
| Builder fee actual rate | Not chosen (cap only is provider-confirmed) | Founder | **FOUNDER APPROVAL REQUIRED** | Founder decision doc; rate configured, not coded | No | Yes | Reversible (rate-change cadence: max once/7 days, 3-day notice — provider constraint, §3) | Configurable product policy, provider-capped | Depends on Builder registration being live |
| Builder registration (actual account) | Register only after custody/signing + relevant legal questions are answered | Founder (to authorize), Counsel (to clear) | **FOUNDER APPROVAL REQUIRED** then **COUNSEL REQUIRED** | Provider-readiness doc row checked with evidence (screenshot/confirmation email) | Yes, for real order submission specifically (the `builder` field is mandatory in the signed order struct) | Yes | Reversible (can re-register) | N/A — one-time provider account action | See provider-readiness.md |
| Builder KYB | Unknown whether required | Provider (to confirm), possibly Counsel | **PROVIDER CONFIRMATION REQUIRED** | Direct confirmation from Polymarket (registration flow observation or `builder@polymarket.com` reply) | Only if KYB turns out to gate order submission itself | Yes (registration cannot complete if it exists and is unmet) | N/A | N/A | Unresolved by two research passes (M4 and this document) |
| KYC/AML/sanctions responsibility | Not decided | Counsel | **COUNSEL REQUIRED** | Legal signoff doc rows checked | Yes if the answer requires new server-side gates before any real quote/order flow | Yes | Reversible (vendor/process can change) | Legal/compliance policy → configurable operational policy once bounded | See §11 |
| Age requirements | Not decided | Counsel | **COUNSEL REQUIRED** | Legal signoff doc row checked | Yes if a gate must exist before launch cohort | Yes | Reversible | Legal/compliance policy | — |
| Legal classification of Brohda's role | Not decided | Counsel | **COUNSEL REQUIRED** | Legal signoff doc "Brohda role reviewed"/"product classification reviewed" checked | Yes — this is the highest-leverage single blocker (gate doc §5 #12) | Yes | N/A (a legal determination, not a design choice) | Legal/compliance policy | Nearly every other row depends on this answer |
| Legacy wallet relationship | Permanent separation (Option A, gate doc §25/§26) is already architecturally locked; the *migration direction* (A/B/C in STEP 17) is not chosen | Founder (direction); Counsel/Accounting if C is ever considered | **FOUNDER APPROVAL REQUIRED** (direction) | Founder decision doc §1 checked | No — separation is already the default and requires no new code to remain true | Yes if the founder later wants a change | Reversible now; C would be a major accounting undertaking | Founder decision | See §17 |
| Secrets architecture (category) | Encrypted-at-rest secret store outside the primary DB (dedicated secrets manager or KMS-envelope-encrypted DB record) — see §15 for the full comparison | Engineering (design), possibly Vendor | **TECHNICAL IMPLEMENTATION REQUIRED**, and **VENDOR DECISION REQUIRED** if a managed secrets manager/KMS is chosen over self-hosted envelope encryption | A written secrets-architecture spec + a security review of the actual implementation once built | Yes | Yes | Reversible pre-launch; hard to reverse post-launch (credential migration) | True invariant: never a raw plaintext DB field. Configurable: which vendor/mechanism | See §15 |
| Execution kill switch | `platform_settings`-style scoped booleans (global/provider/jurisdiction/market/user/cohort), reusing the proven pattern | Engineering | **TECHNICAL IMPLEMENTATION REQUIRED** | Implemented + tested (unit + integration, mirroring Milestone 3/5's own precedent) + a written incident runbook naming who may invoke it | Yes — roadmap and gate doc both name this a hard Milestone 6 prerequisite | Yes | Fully reversible (it's a toggle) | Mechanism: true invariant (must exist). Scopes/state: configurable operational policy | See §20 |
| Rollout cohort mechanism | Configuration-driven (allowlist / percentage / jurisdiction / provider), reusing `platform_settings` pattern | Engineering (mechanism), Founder (actual cohort) | **TECHNICAL IMPLEMENTATION REQUIRED** (mechanism); **FOUNDER APPROVAL REQUIRED** (actual cohort, later) | Mechanism implemented and tested; founder names the initial cohort in founder-decisions.md before launch (not before coding) | No — coding may proceed against the mechanism without the founder having picked the exact cohort yet | Yes | Fully reversible | Mechanism: true invariant. Cohort membership: configurable product policy | See §21 |
| Real execution rate limits | Independent, fail-closed-by-default policy classes (quote/order-submit/cancel/reconciliation/session-key-ops), reusing Milestone 5's `platform_settings`-driven pattern but with new, real values | Engineering | **TECHNICAL IMPLEMENTATION REQUIRED** | Implemented, tested, values sourced from `platform_settings` (never simulated values, never a code constant) | Yes | Yes | Fully reversible (config) | Fail-closed-by-default posture: true invariant. Numeric values: configurable operational policy | See §24 |
| Reconciliation | Provider-authoritative source-of-truth hierarchy (gate doc §18) | Engineering | **TECHNICAL IMPLEMENTATION REQUIRED** | Implemented, tested against the launch test-case list (§23), zero unresolved discrepancies over an observation period (roadmap exit criterion) | Yes | Yes | N/A (a correctness requirement, not a togglable feature) | True invariant (provider is authoritative) | See §23 |
| Audit logging | Event list per gate doc §21 | Engineering | **TECHNICAL IMPLEMENTATION REQUIRED** | Implemented; verified no secret material appears in any log record | Yes | Yes | N/A | True invariant (must exist); which events alert: configurable | See §25 |
| Order idempotency | Reuse the `create_pool_entry`/Prediction idempotency-key pattern, extended for provider-round-trip failure modes | Engineering | **TECHNICAL IMPLEMENTATION REQUIRED** | Implemented, tested against duplicate-submission/timeout/retry scenarios | Yes | Yes | N/A | True invariant | Depends on resolving the "does CLOB support idempotent order IDs" open provider question first (§3) |
| Security review of real code | Independent review of the actual signing/secrets implementation | Engineering + an independent reviewer | **TECHNICAL IMPLEMENTATION REQUIRED** (code must exist first) | A completed, documented review with findings closed | Yes — cannot be skipped per gate doc §31 item 16 | Yes | N/A | N/A | Cannot start until code exists — a sequencing note, not a current blocker |
| Incident response runbook | Documented at operational (not just conceptual) detail | Founder + Engineering | **TECHNICAL IMPLEMENTATION REQUIRED** (as a document + drilled process, not code) | A written runbook covering §22's scenario list, reviewed by the founder | No — does not block writing code, but blocks launch per roadmap's own explicit requirement | Yes | Fully reversible (a document, revisable) | Configurable thresholds within an invariant *requirement that a runbook exist* | See §22 |
| Support/recovery model | Not yet defined | Founder + Engineering | **FOUNDER APPROVAL REQUIRED** then **TECHNICAL IMPLEMENTATION REQUIRED** | Support-case list (§26) triaged into automated/admin-diagnostic/human/provider-escalation buckets, at least the human-escalation path staffed or explicitly deferred with founder sign-off | No | Yes | Reversible | Configurable operational policy (thresholds, routing) | See §26 |

---

## 7. Coding blockers vs. launch blockers (STEP 9)

**Blocks Milestone 6 coding — no real-execution implementation should begin until resolved:**

1. **Custody/signing architecture founder + counsel approval.** Justification: the architecture itself (which secrets exist, what a `Quote`/`OrderIntent`/future `Order` table needs to reference, what the secrets-storage schema looks like) is *determined by* which of Options A–D is approved. Writing `Order`/secrets-storage code against an unapproved architecture risks building something that must be thrown away or, worse, quietly encodes an assumption counsel later rejects.
2. **Legal permission for the chosen model, if the architecture could materially change as a result.** Justification: same reasoning — a "yes, but only with X constraint" answer from counsel (e.g. "Session Keys are fine, but Brohda may never receive delegation broader than per-order amount limits") could change the schema/contract shape, not just a configuration value.
3. **Confirmed provider integration model** (does Brohda actually need to complete Builder KYB, and can Brohda technically register at all in its intended form). Justification: the `ExecutionProvider` adapter's real `submitOrder` implementation needs to know what credential shape it is authenticating with; this is not purely a configuration value, it is a structural fact about the adapter.
4. **Whether the CLOB supports client-idempotent order IDs.** Justification: this single fact determines whether Milestone 6's idempotency contract (gate doc §17) can rely on a provider-side dedupe guarantee or must build a heavier "status-lookup before every retry" pattern as the *only* line of defense — a structural difference in the adapter and reconciliation code, not a tunable.

**Does not block coding but blocks launch** — may be implemented/configured later before production, or may simply be a founder choice made closer to launch:

1. Exact launch cohort (allowlist can be built empty and populated later).
2. Final Builder fee value / Brohda fee value (config, sourced from `platform_settings`, defaults to $0/no revenue until chosen).
3. Final launch limits (min/max order size, daily exposure) — the *mechanism* (configurable, never hard-coded) must be coded; the *values* are a launch-time decision.
4. Operational support staffing.
5. Exact jurisdiction list beyond what counsel initially clears — the *mechanism* (a jurisdiction-eligibility table/config, gate doc §14) must be coded; expanding the list later is a launch-time, not coding-time, decision.
6. Incident-response runbook drilling/rehearsal (the document must exist before launch; a tabletop exercise can happen closer to the actual launch date).
7. Security review of the finished code (necessarily happens after the code that needs reviewing exists — a launch gate, not a coding-start gate).
8. KYC/AML/sanctions *vendor selection*, if the counsel-determined responsibility model requires one — the *capability* (a pluggable eligibility gate) should be coded now if item #3 above resolves in a way that clearly requires it eventually, but the specific vendor contract is a launch-time decision.

---

## 8. Target launch jurisdiction decision structure (STEP 10)

No jurisdiction is hard-coded or chosen by this document. The founder selects one or more candidate jurisdictions in [`milestone-6-founder-decisions.md`](./milestone-6-founder-decisions.md) §"Geography"; counsel then reviews each candidate independently. The structure to record, per candidate jurisdiction (a future `platform_settings`-adjacent or dedicated jurisdiction-eligibility table, **not created by this document**, per STEP 32):

| Field | Purpose |
|---|---|
| `jurisdiction` | ISO country/region code — a configuration value, never a source-code literal |
| `provider_eligibility` | Whether Polymarket itself currently permits trading there (from §3's live-fetched list — re-verified at launch time, not cached from this document) |
| `legal_review_status` | `NOT_STARTED` / `IN_REVIEW` / `APPROVED` / `REJECTED` — set by counsel, never by engineering |
| `kyc_required` | Boolean or enum, set once counsel resolves §11 for this jurisdiction specifically (requirements may differ by jurisdiction) |
| `aml_required` | Same |
| `sanctions_screening_required` | Same |
| `age_requirement` | The minimum age for this jurisdiction, once counsel specifies it — never assumed to be a single global constant |
| `launch_approved` | Boolean — the actual gate checked at runtime; must default to `false`/absent, never `true` by default for a newly-added row |

This table's *existence and shape* is a true invariant of the future geofencing architecture (gate doc §14); its *contents* are 100% legal/compliance policy, populated only after counsel review per jurisdiction. **No jurisdiction may default to eligible.**

---

## 9. KYC/AML decision architecture (STEP 11)

Possible responsibility states, to be selected by counsel (not engineering) once the product's legal classification (§5 #12 in the gate doc) is known:

| State | Meaning | Technical implication |
|---|---|---|
| Provider handles | Polymarket's own KYC/AML (if any — not confirmed this task, §3) is treated as sufficient for Brohda's purposes | Minimal new capability — Brohda would still need *some* eligibility check tied to "does this user have a valid, provider-linked wallet," but no independent identity-verification pipeline |
| Brohda handles | Brohda performs its own KYC/AML independent of whatever Polymarket does | Full future capability list below is required |
| Shared responsibility | Some checks (e.g. sanctions) performed by Brohda, others (e.g. identity) deferred to the provider or a linked wallet's own history | Partial capability list, exact split set by counsel |
| Not required for target model | Counsel determines the initial jurisdiction/product classification genuinely does not require it | No new capability — but this state must be **counsel-confirmed, never engineering-assumed** |
| Counsel unresolved | Default state today | No implementation proceeds past the mechanism-only stage (§7 coding-blocker #1/#2 logic) |

**If Brohda must perform KYC/AML**, future required capabilities (none implemented by this document, per STEP 32):

- Identity verification (a vendor-integration capability — **VENDOR DECISION REQUIRED**, not chosen here)
- Document verification (same)
- Sanctions screening (same — a separate vendor category from identity verification, per gate doc §27's own vendor-category framing)
- A review queue for manual/ambiguous cases
- A data-retention policy matching counsel's record-retention answer (§5 #15/#28)
- An appeal/retry path for a user who fails an automated check incorrectly
- Vendor webhook handling (with the same webhook-security discipline the threat model already requires for order/fill events, threat model §7 — signature verification, idempotent processing, ordering safety)
- Manual review tooling for an admin (diagnostics-first, mutation-narrow, exactly the precedent already set for Prediction/execution admin surfaces)
- Privacy requirements matching counsel's cross-border data-transfer answer (§5 #14)

---

## 10. Sanctions/eligibility hierarchy (STEP 12, conceptual only)

```
Authenticated user (existing requireUser())
  → account eligibility           [new — e.g. account age, verification state]
  → jurisdiction                  [new — §8 table above]
  → sanctions/KYC state           [new — §9 above, shape set by counsel]
  → provider eligibility          [existing pattern from Milestone 5's checkExecutionEligibility, extended]
  → market eligibility            [existing pattern from Prediction/Milestone 5]
  → execution enabled             [kill switch, §20 — global/provider/jurisdiction/market/user/cohort]
  → limits                        [§19 below]
```

Every stage above whose *rule* could reasonably change without changing the architecture (which jurisdictions are eligible, whether a given user's KYC state is sufficient, whether a given cohort has execution enabled, what a limit's numeric value is) **must be configuration, provider-response, or counsel-driven data — never a hard-coded rule in application code.** This mirrors, and extends, the exact discipline `lib/execution/policy.ts`'s `checkExecutionEligibility` already established for simulation in Milestone 5 (a pure function taking a policy object, never embedding a threshold itself) — the real-execution version should be architected as a superset of that function's shape, not a rewrite from scratch. **Not coded by this document.**

---

## 11. Wallet onboarding decision tree (STEP 13, conceptual only)

1. **User becomes execution-eligible** — server action, gated by §10's hierarchy above.
2. **Wallet ownership established** — user action (creates/connects a Deposit Wallet, possibly via an embedded-wallet-style onboarding flow per gate doc §7's recommendation) or, if none exists, a guided creation flow; provider action (Polymarket provisions/recognizes the Deposit Wallet).
3. **Provider account relationship established** — provider action (the wallet is now a recognized Polymarket account); may require the user to accept Polymarket's own terms directly, a fact **not confirmed this task** and worth resolving before implementation.
4. **Session Key created/delegated** — user action (the Deposit Wallet owner authorizes the key, per §2.3 of the gate doc) + server action (Brohda requests/receives the delegated key and must securely store it, §14 below).
5. **Session Key stored securely** — server action, secure-secret handling (§15 below) — this is the single step in the entire tree that is a genuine new security-critical surface for Brohda.
6. **Execution allowed** — server action (the eligibility/kill-switch/limits pipeline, §10, now has a valid Session Key to authorize against).
7. **Delegation expiry tracked** — server action (a scheduled/on-demand check against the known 180-day maximum, §14).
8. **Delegation revoked/rotated** — user action (the user can revoke at any time via the provider) or server action (Brohda-initiated revocation on suspected compromise, §14) or provider action (automatic expiry at 180 days).
9. **Account recovery handled** — provider/wallet-layer responsibility under the recommended architecture (gate doc §8) — **not Brohda's to build**, though Brohda's own onboarding-vendor choice (if an embedded-wallet-style flow is used for step 2) does inherit real recovery-UX responsibility for that specific step.

No table, adapter, or UI is created by this document (STEP 32).

---

## 12. Session Key lifecycle (STEP 14, conceptual only)

| Phase | Definition | Must eventually be configurable? |
|---|---|---|
| Creation | User (Deposit Wallet owner) authorizes a new Session Key scoped to `CLOB` (never `All`, unless a specific future feature genuinely needs `Combos`) | Scope choice: true invariant (least-privilege, `CLOB` only) unless a future feature is explicitly justified otherwise |
| Authorization | The key becomes valid for trading within its scope | N/A (provider-native) |
| Maximum provider duration | **180 days, provider-fixed** (§3) — Brohda cannot request a longer duration | True invariant (provider constraint, not Brohda's to configure) |
| Expiry | At 180 days, or an earlier Brohda-chosen re-authorization cadence | The *Brohda-chosen earlier cadence*, if any, is configurable operational policy |
| Renewal | User re-authorizes before/at expiry | User action; the reminder timing (e.g. "notify at day 165") is configurable |
| Revocation | User-initiated (any time) or Brohda-initiated (suspected compromise) | The Brohda-initiated revocation *capability* is a true invariant (must exist per the threat model's own incident-response requirement, threat model §10); who may invoke it and under what conditions is configurable/founder-decided |
| Rotation | Issuing a new key to replace one nearing expiry or suspected of exposure | Same as renewal |
| Compromised-key handling | Revoke first, investigate second (threat model §10's own explicit ordering) | The *ordering principle* is a true invariant; the specific detection thresholds that trigger a compromise investigation are configurable |
| Logout/account-deletion behavior | Not yet defined — a genuinely new question this document surfaces: does deleting a Brohda account also revoke the associated Session Key? | **OPEN — new item, requires a founder/engineering decision during Milestone 6 design, not resolved here** |
| User revocation | Provider-native, user-initiated at any time, independent of Brohda | True invariant (provider capability) |
| Admin emergency revocation | Must exist per threat model §10; scope (single user vs. cohort) mirrors kill-switch scopes (§20) | Configurable which admin capability gates it (reusing the capability-policy pattern, never a direct role check, per this codebase's own twice-corrected lesson from Prediction diagnostics) |

No key is created by this document.

---

## 13. Secrets-storage decision (STEP 15)

| Option | Encryption at rest | Runtime decryption | Access scope | Rotation | Audit | Environment separation | Incident revocation | Vendor dependency |
|---|---|---|---|---|---|---|---|---|
| Deployment secret store (e.g. hosting platform's own env/secret manager — this codebase's existing pattern for `SUPABASE_SERVICE_ROLE_KEY`) | Platform-dependent, typically yes | Platform-managed | Whatever the hosting platform's own IAM model provides — may be coarser than per-user secrets need | Manual/platform-tooling-dependent | Platform-dependent, often limited | Already proven in this codebase (dev/prod separation, `tests/integration/helpers/test-env.ts`'s own hard-won lesson) | Manual | Low (already in use) — but **not designed for a growing number of per-user secrets**, only a small, static set of platform-level credentials |
| Dedicated KMS/HSM | Yes, hardware- or service-backed | Per-request decrypt call, auditable | Fine-grained IAM policies, per-key | Native support, often automatic | Native, detailed | Strong | Fast, native | **VENDOR DECISION REQUIRED** (e.g. a cloud KMS) unless the hosting platform already includes one |
| Specialized secrets manager (e.g. a dedicated per-user-credential vault product) | Yes | API-mediated | Fine-grained | Native | Native | Strong | Fast | **VENDOR DECISION REQUIRED** |
| Encrypted DB record + KMS envelope encryption | Yes (application-managed) | Application decrypts using a KMS-held data key | As fine-grained as the application's own access-control code makes it | Application-managed (re-encrypt with a new data key) | Whatever the application logs | Reuses this codebase's existing service-role/RLS discipline for the encrypted blob itself, while keeping the actual decryption key out of the database entirely | Application-managed (can be fast if designed for it) | Only for the KMS piece — the DB storage itself needs no new vendor |

**Recommendation (technical, not yet approved)**: **encrypted DB record + KMS envelope encryption**, because it (a) reuses this codebase's proven `execution_quotes`/`order_intents`-style RLS/service-role discipline for the row shape itself, (b) needs only a KMS for the actual key-wrapping step rather than a full new secrets-manager integration, and (c) keeps the plaintext Session Key out of the database at rest, satisfying the explicit "never a raw private/session key in a plain DB field" requirement. **This is a recommendation, not a decision** — it requires engineering sign-off and, if a specific cloud KMS is chosen, a **VENDOR DECISION**.

Required properties regardless of which option is chosen: encryption at rest (non-negotiable — true invariant); runtime decryption scoped to the minimum server-side code path (mirrors this codebase's existing `server-only` discipline); access scope least-privilege; a defined rotation path; audit logging of every access (not the secret value itself); strict dev/prod separation (already proven); a documented incident-revocation path (§12 above, §22 below).

**No vendor was selected, no KMS was provisioned, no secret was stored by this document.**

---

## 14. Funding UX decision (STEP 16, conceptual only)

**Preferred principle** (already locked by the roadmap, §4/§10): users should not need to understand crypto mechanics.

| Question | Answer (architecture only) |
|---|---|
| Where does the balance actually live? | In the user's own Deposit Wallet, held as pUSD (§4) — never in a Brohda-controlled account, under the recommended (still `BLOCKED`-pending-approval) architecture |
| Who owns it? | The user |
| How does Brohda read it? | A provider balance/activity query (read-only, authenticated with the user's own Session Key or a read-scoped credential — not yet confirmed which is required, §3) — never a Brohda-side ledger treated as authoritative (gate doc §18's source-of-truth hierarchy) |
| How does the user add funds? | Not yet designed in UI detail — conceptually, a funding flow that results in the user's Deposit Wallet holding pUSD, likely via a fiat on-ramp or existing crypto on-ramp abstracted behind Brohda's own UI language ("add funds"), never exposing "USDC," "pUSD," "bridge," or "wrap" |
| How do withdrawals work? | The user withdraws directly from their own Deposit Wallet through whatever interface that wallet model exposes — under Option C, Brohda is not a withdrawal intermediary at all |
| Is gas/network mechanics hidden? | Yes, by design — the Deposit Wallet model is Relayer-submitted (gasless) for trading; funding/withdrawal gas mechanics (if any) are the wallet/on-ramp vendor's concern, not Brohda's |
| Failure/recovery paths | Not yet designed — a funding failure (on-ramp declined, bridge stuck) needs its own user-facing, honest-failure-state copy, matching the roadmap's own "silence is never acceptable" principle; not resolved here |

No implementation exists. This table exists so a future Milestone 6 implementer has the shape to design against.

---

## 15. Explicit legacy-wallet decision (STEP 17)

Options, restated from the task's own framing:

- **A — Permanent separation.** Legacy wallet (`wallet_balances`/`wallet_transactions`) remains legacy-only, forever isolated from any provider-execution balance. **This is already the architecturally locked default** (gate doc §25/§26) and requires no new code to remain true — it is the *status quo*, not a pending implementation.
- **B — Controlled wind-down.** Legacy wallet is resolved (paid out / closed) before real execution launches.
- **C — Migration/credit conversion.** Legacy balances convert into the new model. **Explicitly not to be selected without legal/accounting review**, per this task's own instruction — this document does not recommend C and does not evaluate its mechanics, since doing so would presuppose an unmade decision.

**This document does not choose among A/B/C.** The founder must select a direction in [`milestone-6-founder-decisions.md`](./milestone-6-founder-decisions.md). **Not choosing does not block Milestone 6 coding** — the legacy wallet is already isolated by construction (gate doc §26: "must remain completely separate, not reused as shared state"), so writing real-execution code today requires no legacy-wallet decision at all. It **does block a founder-satisfying long-term answer** and should be resolved before Milestone 9 (Legacy Pool Wind-Down) is scoped, per the roadmap's own dependency chain.

---

## 16. Real fee decision framework (STEP 18)

| Component | Source | Known today? |
|---|---|---|
| Provider fee | Polymarket's own CLOB economics — **not confirmed this task or Milestone 4** whether a separate "platform fee" distinct from the builder-fee mechanism exists | **PROVIDER CONFIRMATION REQUIRED** |
| Builder fee | Brohda's own registered rate, capped at 0–100 bps taker / 0–50 bps maker (provider-confirmed, §3); changeable at most once per 7 days with 3-day notice | Cap: known. Actual rate: **FOUNDER APPROVAL REQUIRED** |
| Brohda fee (beyond builder-fee revenue) | Pure founder/business decision | **FOUNDER APPROVAL REQUIRED** — not decided, zero-fee launch is an explicitly acceptable option per the founder-decisions form |
| Network cost | Not applicable under the Deposit Wallet/Relayer model (gasless) — must be re-confirmed if a non-Deposit-Wallet model is ever chosen | Known, conditional on wallet-model decision |
| Spread/slippage | Market-derived, estimated at quote time (reusing Milestone 5's already-proven depth-walk model), reconciled at fill time | Mechanism known; values are always market-derived, never fixed |
| Total user cost | Sum of the above, shown pre-confirmation (already an architecturally locked UX requirement, gate doc §13/§22) | Mechanism known; total value is only knowable once every input above is known |

**Founder must decide** (in founder-decisions.md): whether Brohda charges a fee at all, how it is structured (builder-fee-only, an additional platform fee, or another model), and whether a zero-fee launch is acceptable. **No fee rate is chosen by this document.** Counsel must separately review whether the *chosen* fee structure changes Brohda's regulatory characterization (counsel brief Q3) — this is a sequencing dependency, not a duplicate question. **Every numeric value here must eventually live in configuration** (extending `platform_settings`' existing `execution_simulated_provider_fee_bps`/`execution_simulated_brohda_fee_bps` pattern from Milestone 5 with real, non-simulated equivalents) — **no fee may be hidden from the user at confirmation time**, per the already-locked disclosure requirement.

---

## 17. Execution limits framework (STEP 19)

| Limit | Set by | Where it will live |
|---|---|---|
| Min order | Provider floor (`min_order_size`, read live per market, §3) plus optionally a stricter Brohda floor | Provider-derived value (floor) + configurable product policy (Brohda's own stricter floor, if any) |
| Max order (per-order) | Founder/risk decision | Configurable product policy (`platform_settings`-equivalent, real-execution table — not the simulated one) |
| Daily user maximum | Founder/risk decision | Same |
| Rolling exposure maximum | Founder/risk decision, only if required by the chosen risk posture | Same, only if adopted |
| New-account limit | Founder/risk decision (a stricter limit for accounts below some maturity threshold) | Same |
| Jurisdiction-specific limits | Counsel, if a jurisdiction's regulatory treatment requires a different limit | Legal/compliance policy → configurable |
| Cohort-specific limits | Founder (rollout-stage decision) | Configurable, reusing the rollout-cohort mechanism (§21) |

**No numeric value is chosen here.** This document only defines *where* each limit will live (always configuration, provider-derived, or counsel-driven — **never a source-code constant**, directly per the standing rule) and *who* sets it. Values are chosen only when founder/counsel/provider constraints actually require a specific number, consistent with this document's own instruction not to invent limits speculatively.

---

## 18. Real kill-switch requirements (STEP 20)

| Scope | Meaning |
|---|---|
| Global | All execution, all providers, all users, all jurisdictions off |
| Provider | A single provider (e.g. Polymarket) off — relevant only once/if a second provider ever exists |
| Jurisdiction | A specific jurisdiction's execution off, independent of the global switch |
| Market | A single market pulled (data-quality, legal, or dispute reason) |
| User | A single user's execution disabled (fraud suspicion, dispute, compromised-key response) |
| Cohort | A named rollout cohort's execution off, without affecting other cohorts |

| Requirement | Definition |
|---|---|
| Operator authority | Must reuse the capability-policy pattern already proven for Prediction/simulated-execution diagnostics (`view_prediction_diagnostics`, `view_simulated_execution_diagnostics`) — a dedicated capability (e.g. `manage_execution_kill_switch`), never a direct `requireSuperAdmin()` call, per this codebase's own twice-corrected lesson |
| Fail-safe default | A newly-added scope (e.g. a new jurisdiction row, a new cohort) must default to **execution disabled**, never enabled-by-default — mirrors §8's "no jurisdiction may default to eligible" rule |
| Audit record | Every kill-switch invocation (on or off, any scope) must be an audit event (gate doc §21's list already includes "kill-switch invoked") |
| Notification behavior | Configurable — who is notified (on-call engineer, founder, affected users) and how, per scope; must not be silent for a global or jurisdiction-wide invocation |
| Propagation requirement | Must take effect on the very next request with no deployment — reusing `platform_settings`' already-proven live-read pattern (Milestones 2/3/5 all already rely on this), not a config file requiring a rebuild |

**Founder/admin changes to any of the above must never require a deployment** — this is a true invariant of the mechanism itself, exactly matching the standing rule's own explicit emphasis. **Not implemented by this document.**

---

## 19. Launch cohort requirements (STEP 21)

Potential first-cohort models, in increasing order of exposure: founder-only → internal team → explicit allowlist → invited beta users → percentage rollout. **The founder chooses later** (this is explicitly deferred to launch time, not a coding blocker per §7). The *architecture* must support changing the cohort definition without a deployment — this is a true invariant of the mechanism, reusing the same `platform_settings`/allowlist pattern already proven for `registration_enabled`/discovery/prediction/simulated-execution policy toggles across Milestones 1–5. **No cohort is chosen and no allowlist table is created by this document.**

---

## 20. Incident-response gate (STEP 22)

For each scenario, this document defines the *shape* of the required response, not an implemented tool or a claim that a 24/7 operational team currently exists — **no such team is claimed to exist**, per the task's own explicit instruction not to overstate operational readiness.

| Scenario | Immediate action | Kill-switch scope | Evidence preservation | Provider contact | User communication | Credential rotation | Reconciliation | Postmortem |
|---|---|---|---|---|---|---|---|---|
| Suspected Session Key compromise | Revoke the key immediately (revoke first, investigate second — threat model §10's own ordering) | User (that one account) | Preserve the audit trail for the affected user's recent order activity before any cleanup | Not typically needed (revocation is self-service/API-driven) | Notify the affected user | Issue a new Session Key only after investigation | Reconcile the user's actual provider-side order/fill state against Brohda's records | Required |
| Builder credential leak | Rotate the builder credential via Polymarket's own builder-profile tooling | Global (a leaked builder credential can affect every order, not one user) | Preserve logs of all orders submitted with the affected credential in the suspected window | Yes — contact Polymarket/Builder support | Only if user-facing impact is confirmed | Immediate | Compare Brohda's own order records against provider Builder Leaderboard/fee-payout records for the affected window | Required |
| Unauthorized order | Kill-switch the affected user immediately; do not attempt to "undo" the order client-side | User | Preserve the full request chain (quote → confirmation → signing → submission) for the affected order | Yes, if the order cannot be resolved through normal cancellation | Yes — proactive, per the roadmap's own "silence is never acceptable" principle | If a compromised Session Key is implicated | Reconcile against provider order/fill state | Required |
| Duplicate order | Reconcile via provider status lookup before assuming either order is "the real one" (gate doc §17/§18) | None automatically — investigate first | Preserve both order attempts' full intent records | Only if the duplicate cannot be resolved via read-only reconciliation | If a user was double-charged/double-exposed | No | Primary response — this scenario is fundamentally a reconciliation problem | If the root cause is a Brohda idempotency bug |
| Provider outage | Circuit-breaker auto-disables new quotes/orders (gate doc §23) — this should be automatic, not solely manual | Provider (Polymarket) | N/A unless data loss is suspected | Monitor provider status; contact if prolonged | If materially affecting active users | No | Resume with a reconciliation pass once the provider recovers, before re-enabling | Only if the outage caused a reconciliation discrepancy |
| Reconciliation mismatch | Do not silently resolve — surface as `RECONCILIATION_REQUIRED` (gate doc §19), escalate to a human | None automatic; consider user-scoped if the mismatch implies incorrect exposure was shown | Preserve both Brohda's and the provider's state at time of mismatch | Only if the provider's own data appears wrong | Only once resolved, with an accurate explanation | No | The mismatch itself IS the reconciliation event | Required if the root cause is systemic (not a one-off) |
| Incorrect fee | Investigate whether it's a configuration bug or a provider-side fee-calculation change (§3 notes builder fee rate changes require the builder's own 3-day-notice cadence — an *unexpected* fee change may indicate a provider-side issue) | None automatic | Preserve the quote-time vs. fill-time fee figures | If provider-side | Yes, transparently, per the disclosure principle already locked (gate doc §13) | No | Compare configured fee vs. actually-charged fee across recent orders | Required |
| Incorrect market | Investigate whether market-ID substitution occurred (threat model #14) or a data-sync bug | Market-scoped, if the market itself is misconfigured | Preserve the full quote/confirmation chain for affected orders | No, unless the market data itself came from the provider incorrectly | Yes, if any user was affected | No | Reconcile affected orders individually | Required |
| User eligibility bypass | Immediately revoke execution access for the affected account; investigate the specific gate that failed (§10's hierarchy) | User-scoped, escalate to jurisdiction-scoped if systemic | Preserve the eligibility-check audit trail | No | Only if legally/contractually required | No | N/A unless a real order resulted | Required |
| Sanctions/KYC bypass | Same as above, but treat as higher severity — escalate to counsel, not just engineering | User-scoped immediately; consider broader if the bypass is systemic | Preserve full audit trail | No | Per counsel's guidance, not engineering's | No | N/A unless a real order resulted | Required, with counsel involvement |
| Quote/order mismatch | Reject the confirmation rather than honor a mismatched value (already the exact discipline Milestone 5 proved for simulation — recalculation-tolerance rejection, never silent re-pricing) | None automatic | Preserve the quote snapshot and the confirmation-time re-derivation | No | Only if a user was shown an incorrect result | No | N/A — the rejection itself is the correct outcome | Only if the rejection rate spikes unexpectedly |
| Database compromise | Assume the worst — rotate every credential the database could have exposed (including any encrypted Session Key material, per §13's KMS-envelope design, whose plaintext should never have been in the DB in the first place) | Global | Full forensic preservation, coordinate with whatever incident-response process the broader Brohda infrastructure already has (or does not yet have — **not claimed to exist by this document**) | Only if user funds/wallets could be directly implicated — under Option C, a DB compromise alone cannot withdraw funds (§13/§12), which is the single largest mitigating fact | Yes, transparently | All secrets | Full reconciliation pass across all affected users | Required, highest severity |

**No claim is made that a 24/7 on-call rotation, a formal incident-response team, or existing tooling for any of the above currently exists.** This table defines what *must* exist before launch (roadmap's own explicit requirement for "a documented incident-response runbook... before rollout begins"), not what already does.

---

## 21. Reconciliation launch requirements (STEP 23)

Required flows to reconcile (restated from the gate doc §18's already-locked source-of-truth hierarchy, made concrete for launch testing):

| Flow | What "reconciled correctly" means |
|---|---|
| Order acknowledged | Brohda's `OrderIntent`/`Order` record reflects the provider's own acknowledgement, not an optimistic assumption |
| Order lookup | Brohda can, at any time, independently re-derive an order's current state from the provider (not solely from cached webhook/event data) |
| Fills | Every provider-reported fill is reflected exactly once in Brohda's own fill record |
| Partial fills | Aggregate correctly into one order's fill history; never displayed as "nothing happened" or "fully filled" |
| Cancellation | A cancel that loses the race to a match (delay-window behavior, §3) is handled as an expected, distinct outcome — not an error |
| Timeout recovery | A Brohda-side request timeout is *never* auto-classified as success or failure — always resolved via a provider status lookup before any user-facing state changes |
| Position derivation | The resulting financial exposure (Milestone 7's own domain) is derivable purely from reconciled order/fill state, never from Brohda's own optimistic cache |
| Balance reconciliation | Brohda's cached view of a user's tradeable balance, if cached at all, is always re-verifiable against the provider — never trusted as authoritative on its own (gate doc §18) |
| Settlement | Resolution/redemption events close out positions correctly without corrupting the underlying (permanent) Prediction record |
| Correction handling | A decision, consciously made (not defaulted into), on whether a post-finalization provider correction retroactively updates a closed record — the gate doc explicitly flags this as undecided |
| Duplicate event handling | A redelivered webhook/event must not double-process a fill (threat model §7) |

**Launch test cases** (defined here, not implemented): (1) a normal order fills completely and reconciles; (2) an order partially fills, then the remainder is cancelled, and both events reconcile into one coherent history; (3) an order times out from Brohda's perspective but the provider actually accepted it — reconciliation must discover and correctly record this without a duplicate submission; (4) a cancel is attempted during a delay window and loses the race to a match — reconciliation must record the match, not an erroneous cancellation; (5) a provider outage occurs mid-flow and reconciliation correctly catches up once the provider recovers; (6) a duplicate webhook/event is delivered and does not double-process; (7) a reconciliation mismatch that cannot be automatically resolved is correctly surfaced as `RECONCILIATION_REQUIRED` and escalated, never silently guessed.

**Open gap**: whether the CLOB supports client-idempotent order IDs (§3) directly affects how test case #3 above can be implemented with confidence — this remains a coding blocker (§7) until resolved.

---

## 22. Real execution rate-limit requirements (STEP 24)

Milestone 5 proved the *mechanism* (configurable window/max-attempts/enabled flag, sourced from `platform_settings`, fail-open for reads / fail-closed for the one mutating class it had). Real execution needs the same mechanism extended to more, and more consequential, classes — **Milestone 5's actual simulated values must never be reused as real-execution launch values**, since they were calibrated for a zero-financial-exposure feature.

| Class | Suggested default posture | Rationale |
|---|---|---|
| Quote | Fail-open (read-only, no financial exposure at the quote stage itself) | Matches Milestone 5's own precedent for the equivalent simulated class |
| Order submit | **Fail-closed** | Real financial exposure — an infrastructure failure must never silently allow unlimited real order submission (gate doc §24's own already-made decision) |
| Cancel | **Fail-closed**, unless explicitly justified otherwise | A cancel failure that's allowed through unlimited could itself be abused (e.g. cancel-spam against a market-maker's resting orders) — default to the conservative posture unless a specific reason to diverge is documented |
| Reconciliation (status-lookup polling) | Fail-open is plausible (read-only), but must be justified explicitly, not assumed, since reconciliation itself is a financial-integrity control (§8 of the threat model) | Requires an explicit design decision, not inherited automatically from the quote class |
| Session-key operations (create/revoke/rotate) | **Fail-closed** | These are security-critical secret-management operations, not ordinary reads |

Every numeric window/max-attempts value for every class above must be configurable (extending Milestone 5's `execution_{quote,confirmation}_rate_limit_*`-style `platform_settings` columns with real-execution-specific columns — **not reusing the same columns**, since real and simulated traffic must remain independently tunable, mirroring Milestone 5's own deliberate separation from Prediction's rate limiter). **No values are chosen or implemented by this document.**

---

## 23. Production observability requirements (STEP 25)

Required signals (restated from gate doc §21, organized for launch-readiness review):

order intent created; eligibility denied (with the specific gate that failed); quote generated; signing attempt; provider submission; provider acknowledgement; fill; partial fill; cancel; timeout; reconciliation mismatch; position change; settlement; kill-switch event; policy change; credential rotation.

**Alert-worthy states** (a subset requiring active notification, not just a log record): reconciliation mismatch; `RECONCILIATION_REQUIRED`; kill-switch invocation (any scope); a rate-limiter fail-closed event triggering repeatedly (may indicate an infrastructure problem, not just legitimate throttling); a signing failure spike (may indicate Session Key expiry-wave or a compromise); a provider-outage circuit-breaker trip; any credential-rotation event outside a planned rotation window.

**Never logged**: private keys, Session Key material, raw EIP-712 signatures, full auth credentials, any full secret-bearing payload — restated, not weakened, from gate doc §21. Correlation via the `OrderIntent`'s own client-generated ID, threaded through every subsequent event, mirroring the existing Prediction correlation pattern. **Not implemented by this document.**

---

## 24. Production support requirements (STEP 26)

| Support case | Automated explanation | Admin diagnostic | Human support | Provider escalation |
|---|---|---|---|---|
| Order missing | Yes (reconciliation-derived status) | Yes | If automated resolution fails | If the provider's own record disagrees |
| Order duplicated | Partial (surface the duplicate) | Yes | Yes | If unresolved by reconciliation |
| Wrong amount | Partial (show quote-vs-fill breakdown) | Yes | Yes | Rarely (usually a Brohda-side display or reconciliation issue) |
| Market closed | Yes | No | No | No |
| Funds unavailable | Yes (this is provider/wallet state Brohda can query, not hold, under Option C) | Yes | If user disputes the provider's own reported balance | If provider data itself looks wrong |
| Wallet inaccessible | No — this is the user's own wallet/recovery problem under Option C, not Brohda's to fix | Diagnostic only (confirm Brohda-side state is unaffected) | Yes, to explain the boundary honestly | No |
| Session Key expired | Yes (clear "please re-authorize" messaging) | Yes | If the re-authorization flow itself fails | No |
| Cash-out unavailable | Yes (Milestone 7 scope, not Milestone 6) | N/A for Milestone 6 | N/A | N/A |
| Provider outage | Yes (circuit-breaker-driven honest messaging) | Yes | If prolonged | Yes |
| Settlement dispute | No — needs a human | Yes (diagnostic evidence) | Yes | If the dispute concerns the provider's own resolution |
| Account restricted | Yes (kill-switch/eligibility-driven messaging, honest about why where legally permissible) | Yes | If the user disputes the restriction | Only if provider-side |

No support tooling is built by this document. This table exists to scope what a future support-readiness effort must cover.

---

## 25. Provider readiness

See the dedicated [`docs/architecture/milestone-6-provider-readiness.md`](./milestone-6-provider-readiness.md) checklist (STEP 29).

---

## 26. Technical implementation checklist (STEP 30, planning only)

No code from this list is implemented by this document (STEP 32).

- [ ] Real `ExecutionProvider` adapter (extends, does not replace, Milestone 5's `ExecutionQuoteProvider` boundary — gate doc §10)
- [ ] Order submission (`submitOrder`)
- [ ] Cancellation (`cancelOrder`)
- [ ] Provider credentials (Builder registration credential handling)
- [ ] Session Key lifecycle (creation request, storage, expiry tracking, revocation, rotation — §12/§14)
- [ ] Encrypted secret storage (§15 — the actual implementation of the chosen architecture)
- [ ] Account/wallet linkage (associating a Brohda user with their Deposit Wallet/Session Key state)
- [ ] Real eligibility pipeline (§10's full hierarchy, extending Milestone 5's `checkExecutionEligibility` shape)
- [ ] Geography enforcement (§8's jurisdiction table + server-side enforcement, never client-only per the threat model's own explicit warning)
- [ ] KYC/AML integration, if required by counsel (§9)
- [ ] Sanctions checks, if required by counsel (§9)
- [ ] Real fee configuration (§16 — extending `platform_settings` with real, non-simulated fee columns)
- [ ] Kill switch (§20)
- [ ] Controlled rollout (§21)
- [ ] Real rate limits (§22)
- [ ] Order idempotency (§21, contingent on resolving the client-idempotent-order-ID open question)
- [ ] Reconciliation (§21)
- [ ] Position creation (the `Position` record itself — Milestone 7 fully realizes it, but Milestone 6 must create it per the roadmap's own scope)
- [ ] Audit events (§23)
- [ ] Alerts (§23)
- [ ] Admin diagnostics (reusing the capability-policy, read-only-first precedent already established twice — Prediction, simulated-execution)
- [ ] Incident controls (the kill-switch invocation UI/API + the runbook's technical hooks, §20/§22)
- [ ] Tests (unit, integration against local Supabase only, E2E — same three-tier rigor as every prior milestone)
- [ ] Security review (of the actually-implemented signing/secrets code, gate doc §31 item 16)

---

## 27. Milestone 6 implementation authorization (STEP 31)

## MILESTONE 6 IMPLEMENTATION AUTHORIZATION: **NOT AUTHORIZED**

**Reason**: Every coding-blocker item in §7 remains unresolved:

1. Custody model — `BLOCKED` (founder + counsel, §6 row 1)
2. Signing model — `BLOCKED` (founder + counsel, §6 row 3)
3. Legal classification of Brohda's role — `COUNSEL REQUIRED` (§6, nearly every other row depends on this)
4. Confirmed provider integration model — `PROVIDER CONFIRMATION REQUIRED` (Builder KYB unresolved after two research passes, §3/§5)
5. Whether the CLOB supports client-idempotent order IDs — `PROVIDER CONFIRMATION REQUIRED` (§3/§21, directly shapes the idempotency/reconciliation adapter contract)

None of these is a launch-only item that can be deferred past coding-start; each one shapes the *structure* of code that does not yet exist (which secrets a table must reference, what an adapter's real submission contract looks like, whether a heavier client-side dedupe pattern is structurally required). Beginning real-execution implementation before these resolve risks building against an architecture that counsel, the founder, or the provider's own actual registration flow later invalidates — exactly the outcome this readiness gate exists to prevent.

Multiple launch-only blockers also remain open (§7's second list) but, per this task's own instruction, **do not by themselves justify NOT AUTHORIZED** — they are listed for completeness and because Milestone 6 implementation, once authorized, must still not reach production launch until they close.

**Exact items that must be closed before authorization changes to AUTHORIZED TO BEGIN:**

1. Founder decision doc (`milestone-6-founder-decisions.md`) fully completed for at minimum: custody, wallet ownership, signing model.
2. Counsel sign-off (`milestone-6-legal-signoff.md`) completed for at minimum: product classification, Brohda's role, custody, delegated signing.
3. Provider confirmation, obtained directly (not inferred from documentation) for: Builder KYB requirement, and whether the CLOB API supports a client-supplied idempotent order/request ID.
4. No item above may be marked resolved by an engineering task's own judgment — each requires the specific authority named in §6's "Authority required" column.

**If NOT AUTHORIZED**: Milestone 6 remains blocked. Do not implement real-money execution until the listed coding blockers are explicitly closed.

---

## 28. Hard-coding readiness audit (STEP 33)

| Category | Items |
|---|---|
| **True invariant** | `ExecutionProvider`/`Quote`/`OrderIntent`/`Order`/`Fill`/`Position` conceptual contract shapes (gate doc §10); Prediction/Order/Position structural separation (gate doc §11); provider-authoritative source-of-truth hierarchy (§21); fail-closed-by-default posture for order-submit/cancel/session-key-operation rate limits (§22, the *posture*, not the numeric values); the requirement that a kill switch and a rollout-cohort mechanism exist at all (§18/§19, the *mechanism*, not their state); the requirement that Session Keys are scoped to `CLOB` only absent explicit justification (§12); the requirement that no jurisdiction/cohort/newly-added row defaults to eligible/enabled (§8/§18); the "revoke first, investigate second" compromised-key ordering (§12/§20); the requirement that secrets are never stored as raw plaintext in a DB field (§13); the requirement that every mutating rate-limit class defaults fail-closed unless explicitly justified otherwise (§22) |
| **Configurable product policy** | Min/max order size (Brohda's own stricter floor, if any); daily/rolling exposure limits; new-account limits; cohort-specific limits; rollout-cohort membership; fee philosophy and Brohda's own fee rate; jurisdiction list (once legally bounded); disclosure/simulation-adjacent copy for real execution equivalents |
| **Configurable operational policy** | Quote/order-submit/cancel/reconciliation/session-key-operation rate-limit window/max-attempts values; quote expiry / stale-data thresholds (real-execution equivalents of Milestone 5's columns); slippage tolerance; recalculation tolerance; reconciliation polling cadence; retry counts/timeout values; kill-switch scoped states; alert thresholds; support-case routing thresholds; incident-detection thresholds |
| **Provider-derived value** | `min_order_size`/`tick_size` (read live per market, can change mid-session per §3's new finding); the geographic-restriction list itself (Polymarket's own, re-fetched at launch, never cached from this document); builder-fee cap (0–100/0–50 bps); the 180-day Session Key maximum; the 7-day/3-day builder-fee-change cadence; general and order-specific API rate limits |
| **Legal/compliance policy** | Whether KYC/AML/sanctions screening is required and by whom (§9); age requirements; which jurisdictions are legally permissible (distinct from which Polymarket permits, §3/§8); record-retention duration; tax/reporting behavior; consumer disclosure content requirements |
| **Founder decision** | Custody philosophy; wallet ownership; signing model (subject to counsel); crypto-visible UX principle; initial jurisdiction candidates (subject to counsel); fee philosophy; rollout philosophy; legacy-wallet direction; risk acceptance |
| **Vendor decision** | Secrets-storage KMS/manager (if a managed option is chosen over self-hosted envelope encryption, §15); embedded-wallet-as-a-service (only if Option B is ever used for wallet creation, gate doc §27); KYC/identity-verification vendor (if required, §9); sanctions-screening vendor (if required, §9); geolocation vendor (if IP-based enforcement is chosen, §8) |

**Hard-coded mutable future policy planned: NONE.** Every mutable item above is explicitly designed to live outside application source code — no numeric fee, limit, jurisdiction, threshold, or toggle is proposed as a code constant anywhere in this readiness package.

---

## 29. Workspace integrity (STEP 34)

See the completion report for the full three-point SHA-256 snapshot (before edits / before final verification / after final verification) covering: the Milestone 4 gate document, the Milestone 5 simulated-execution document, the threat model, and this document's own companions. No unexplained mutation occurred to any pre-existing file; only the five required new documents (plus this one) were created.

---

## 30. Roadmap conflicts

None identified. This document's classifications are consistent with the roadmap's own Milestone 6 framing (§7: "Founder decisions required before starting: Initial rollout cohort size/selection; explicit kill-switch mechanism and who holds it") and its own Founder Decision Register (§9) OPEN items, all of which remain correctly OPEN here rather than being silently resolved.
