# Execution Architecture Gate — Milestone 4

**Status**: Implements `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 4 — Execution Architecture Gate, the roadmap's sole **HARD GATE**. This document is research, architecture, and decision documentation only. **No real-money execution code, order-placement code, signing code, custody code, or wallet-integration code was introduced by this milestone.** Nothing in this document authorizes Milestone 5 or Milestone 6 implementation on its own — see §16/§17's explicit prerequisite checklists.

> If you are reading this to decide whether Brohda may place a real order, sign a real transaction, or move real user funds: **the answer is no, not yet.** Every item in §31 (Milestone 6 hard prerequisites) must be independently resolved and approved first, and several of those approvals (marked `COUNSEL REQUIRED` in the Decision Register, §29) cannot be granted by an engineering task at all.

**Update**: A dedicated Milestone 6 readiness/decision gate has since consolidated every open item from this document (plus Milestone 5's own findings) into an auditable decision matrix, re-verified current Polymarket provider facts (including resolving the pUSD/USDC discrepancy flagged in §1 below), and produced founder/counsel-facing sign-off forms. See [`docs/architecture/milestone-6-readiness.md`](./milestone-6-readiness.md). That document's own authorization decision governs whether Milestone 6 implementation may begin — it is not superseded by this document's own §31/§29, which remain accurate as of Milestone 4 but do not reflect this later research.

---

## 1. Research methodology and honesty discipline

All Polymarket-specific facts in this document are either **(a)** fetched directly from `docs.polymarket.com` during this milestone (dated 2026-09-16, cited inline with the exact page) or **(b)** carried forward, re-cited, from Milestone 1's own equally-dated research (`docs/architecture/prediction-market-provider.md`). Nothing here is drawn from pre-training knowledge presented as current fact. Where official docs were ambiguous, silent, or could not be independently corroborated within this milestone's scope, that is stated explicitly rather than filled in with a plausible-sounding guess — per this milestone's own explicit instruction ("do not guess").

One material discrepancy surfaced during research and is flagged, not silently resolved: `docs.polymarket.com/concepts/positions-tokens` (fetched 2026-09-16) describes the settlement/collateral asset as **"pUSD"**, distinct from the "USDC" terminology more commonly associated with Polymarket historically (including in this codebase's own Milestone 1 audit notes). This may reflect a genuine platform evolution (a stablecoin migration/rebrand) or may be inconsistent phrasing across the provider's own documentation set. **This must be independently re-confirmed — e.g. via a live read-only Gamma/CLOB API response's own collateral field — before Milestone 5/6 treats either name as authoritative.** Not resolved here; carried forward as an open technical verification item (§18).

---

## 2. Polymarket execution architecture — current official documentation

### 2.1 Trading API / CLOB

| Finding | Source | Date |
|---|---|---|
| Orders are placed via the CLOB API; a client needs a wallet address and a signer (private key or delegated signer) | `docs.polymarket.com/developers/CLOB/introduction` | 2026-09-16 |
| Two-tier authentication: an **L1 signature** attests ownership of the signer address; successful L1 auth yields **L2 credentials** used for all subsequent private requests, including order placement | `docs.polymarket.com/trading/wallets-auth.md` | 2026-09-16 |
| Order payload fields: `tokenId`, `side` (0=BUY/1=SELL), `price` (must conform to the market's `tick_size`), `size` (must meet `min_order_size`), `expiration` (0 = GTC), `signatureType` (0–3, identifies wallet type), `salt`, `maker`, `signer`, `makerAmount`, `takerAmount`, `builder` (bytes32) | `docs.polymarket.com/developers/CLOB/orders/create-order` | 2026-09-16 |
| Signing is **EIP-712 typed-data signing** against the "Polymarket CTF Exchange" v2 domain on chain 137 (Polygon); a Deposit Wallet signs a `TypedDataSign` wrapper for ERC-7739 validation, while Proxy/Safe/EOA wallets sign the Exchange `Order` struct directly | same | 2026-09-16 |
| Price/size precision is tick-size-dependent (e.g. 0.01 tick → 2 price decimals / 2 size decimals / 4 amount decimals; 0.001 tick → 3/2/5) | same | 2026-09-16 |
| Time-in-force: GTC (no expiry) and GTD (expires at a Unix timestamp; **enforced one minute before the stated expiration as a stated security threshold**, and GTD orders must be created with at least a 3-minute future duration) | same | 2026-09-16 |
| Order lifecycle statuses: `live` (resting), `matched` (filled immediately), `delayed` (in an async delay window on seconds-delay markets), `unmatched` (survived the delay window with no match) | `docs.polymarket.com/concepts/order-lifecycle.md` | 2026-09-16 |
| Post-match trade statuses: `MATCHED` → `MINED` → `CONFIRMED` (terminal, success) or `RETRYING` → `FAILED` (terminal, failure) | same | 2026-09-16 |
| **Partial fills cannot themselves be cancelled — only the still-unfilled remainder of an order can be** | same | 2026-09-16 |
| During a delay window (250ms on crypto markets; a configured period on sports markets) an order **cannot be cancelled**, and a validation failure at the end of that window causes **rejection, not a race with cancellation** | same | 2026-09-16 |
| Settlement/collateral asset: described as **"pUSD"**, ERC-1155 outcome tokens on Polygon, each YES/NO pair backed 1:1 by locked collateral; winning tokens redeem 1:1, losing tokens become worthless; a holder may also **merge** equal YES+NO back to the collateral without trading | `docs.polymarket.com/concepts/positions-tokens.md` | 2026-09-16 — **see the discrepancy note in §1** |

**Not found / not resolvable from the pages fetched this milestone**: a dedicated, comprehensive REST/WebSocket rate-limit table for ordinary (non-Relayer, non-builder) trading endpoints (Builder Tiers documents Relayer-transaction daily caps specifically, not general API rate limits — see §2.2); a single authoritative "reconciliation API" page distinct from Manage Orders / Wallet Activity / Real-Time Order Updates (not independently fetched this milestone — flagged as an open item for whoever implements Milestone 6's reconciliation code to verify directly, per this task's own "verify... where feasible" instruction rather than inherited unverified here).

### 2.2 Builder / third-party integration model

| Finding | Source | Date |
|---|---|---|
| A **Builder** program exists for third-party applications routing orders through Polymarket; registration is via a builder profile, with a builder identifier (`builder`, a `bytes32` field) embedded directly in the signed order struct | `docs.polymarket.com/programs/builders/overview.md`, `.../fees.md` | 2026-09-16 |
| Builder fee caps: **taker fee rate 0–100 bps (0–1%)**, **maker fee rate 0–50 bps (0–0.5%)**, minimum increment 1 bps; maker and taker sides of the *same* trade may carry different builder codes/rates (a builder is not guaranteed to earn on both sides) | `docs.polymarket.com/programs/builders/fees.md` | 2026-09-16 |
| Builder fee attribution is **onchain and immutable** once an order is signed (it's part of the signed struct, not a separate off-chain label) | same | 2026-09-16 |
| Fee payout: computed at match time, settled onchain, indexed by "the Builders Service," and paid to "the wallet associated with your builder profile" — implying a builder needs at least a receiving wallet, though the fetched page did not state a KYC/approval requirement explicitly for the payout wallet itself | same | 2026-09-16 |
| Builder tiers: **Unverified** (no approval needed, 100 Relayer transactions/day), **Verified** (manual approval after demonstrated usage, 10,000/day), **Partner** (enterprise, unlimited) — upgrade requires emailing `builder@polymarket.com` with the builder key and use case, reviewed "within a few business days" | `docs.polymarket.com/programs/builders/tiers.md` | 2026-09-16 |
| Non-Relayer API endpoints (CLOB, Gamma, etc.) receive "Standard" rate limits at every tier except Partner ("Highest") — **exact requests-per-second/minute figures were not given** in the page fetched | same | 2026-09-16 |

**Not found**: whether becoming a Builder requires the operating company (Brohda) itself to complete any KYB/compliance step distinct from the technical registration flow described. Not stated in the pages fetched — **OPEN, requires either a live registration-flow walkthrough or direct provider contact**, not resolved here (this milestone does not create real accounts per the hard-stop rule).

### 2.3 Wallet / signing model

| Finding | Source | Date |
|---|---|---|
| Four wallet models exist: **Deposit Wallet** (current default for accounts created after May 4, 2026 — a smart wallet where the user signs and Polymarket's Relayer submits gaslessly), **Proxy Wallet** (legacy, Magic Link/Google-authenticated), **Safe Wallet** (legacy, external signer e.g. MetaMask), **EOA** (direct account, allowlisted traders, user pays gas) | `docs.polymarket.com/trading/wallets-auth.md` | 2026-09-16 |
| **No wallet type permits a third party to sign or submit orders without either the user's own private key, or explicit, scoped, time-limited delegation** | same | 2026-09-16 |
| **Session Keys** (Deposit Wallet only) are the one documented delegation mechanism: a Deposit Wallet owner can authorize a separate signer scoped to a venue (`CLOB`, `Combos`, or `All`) for up to **180 days** (no shorter expiration currently supported); revocation is available before expiry | `docs.polymarket.com/trading/session-keys.md` | 2026-09-16 |
| **A Session Key cannot withdraw funds from the Deposit Wallet** — its blast radius is limited to placing/cancelling orders within its scope, not draining the account | same | 2026-09-16 |
| Revoking a Session Key immediately removes it from the "Wallet Registry" and asynchronously cancels its open orders (described as taking "minutes" to fully finalize onchain) | same | 2026-09-16 |

**Architectural significance for §6/§9 below**: Session Keys are the closest documented Polymarket-native analog to "Option C — Delegated signing" in this task's own framing, and are the only mechanism under which a third-party application like Brohda could plausibly execute on a user's behalf **without Brohda ever holding the user's primary private key**. This is a genuine, provider-confirmed capability, not a speculative one — but it still requires **the user to hold and control a Deposit Wallet in the first place**, and it still exposes the session key material to whichever system requests it (§9's threat model treats a leaked Session Key as a real, if bounded, compromise).

### 2.4 Geographic / provider restrictions

| Finding | Source | Date |
|---|---|---|
| **Trading is blocked in the United States on polymarket.com**; US traffic is redirected to a **separate product, `polymarket.us`** | `polymarket.com/tos` (landing excerpt) | 2026-09-16 |

**Not found / not resolvable this milestone**: a comprehensive list of jurisdictions Polymarket blocks beyond the United States; the enforcement mechanism (IP geolocation vs. KYC vs. wallet-based); any published VPN/proxy-circumvention policy; whether `polymarket.us` operates under a materially different regulatory model that would matter if Brohda ever integrated with it instead of/alongside the main platform. The only page fetchable via WebFetch this milestone was a landing excerpt of the Terms of Use, not the full legal text — **this is explicitly insufficient to treat as a complete restricted-jurisdiction list**, and is not treated as one. See §4 for why this is a *provider* fact and categorically separate from *Brohda's own* legal eligibility question.

---

## 3. Provider read-only vs. mutating endpoints — summary

| Class | Examples | Milestone 4 status |
|---|---|---|
| Read-only, unauthenticated | Gamma market/event listing (already used by Milestone 1), CLOB order-book reads, resolution status | Already in use (Milestone 1/2); safe to extend for Milestone 5 quote display |
| Read-only, authenticated | Wallet Activity, Manage Orders (viewing one's own orders), Real-Time Order Updates | Not yet used anywhere in this codebase; would require a real user-owned Session Key or wallet to exercise even read-only — **not exercised in this milestone**, since doing so would require real wallet/credential material this milestone's hard-stop rule forbids creating |
| Mutating | Order creation (`create-order`), cancellation, Session Key authorization/revocation, deposits/withdrawals | **Explicitly out of scope for this milestone and every prototype restriction in §32 of the task instructions.** None called, none prototyped. |

---

## 4. Provider restriction vs. Brohda legal eligibility — explicitly separate questions

**Provider restriction** (§2.4): what Polymarket itself currently permits or blocks (confirmed: US persons blocked on polymarket.com; broader jurisdiction list not independently confirmed this milestone).

**Brohda legal/compliance eligibility**: an entirely separate question this milestone does **not** and **cannot** answer — namely, in which jurisdictions Brohda itself would be legally permitted to offer a product that lets a consumer act on a Polymarket-priced market, under what license or exemption, and under what regulatory characterization (see §5). **A jurisdiction Polymarket itself permits is not evidence Brohda may operate there**, and a jurisdiction Polymarket blocks does not exhaust the list of jurisdictions Brohda must independently avoid. These two questions are tracked as separate rows in the Decision Register (§15, items 8 and 9) and neither is marked `LOCKED`.

---

## 5. Legal/compliance decision checklist

No legal conclusions are offered below — only the concrete questions that require counsel, each classified.

| # | Question | Classification |
|---|---|---|
| 1 | Is Brohda, by routing user intent to Polymarket, acting as an introducer, agent, broker, intermediary platform operator, or something else under applicable law? | **LEGAL COUNSEL REQUIRED** |
| 2 | Does attaching a Builder fee to routed orders change Brohda's regulatory characterization (e.g. from a pure UI/interface to a party earning transaction-based revenue)? | **LEGAL COUNSEL REQUIRED** |
| 3 | Does any Brohda-side custody of funds (even transiently) trigger money-transmitter or custodial-license obligations in any jurisdiction Brohda would operate in? | **LEGAL COUNSEL REQUIRED** |
| 4 | If Brohda ever holds a Session Key (or any signing material) on a user's behalf, does that create a fiduciary, agency, or custodial relationship distinct from a pure non-custodial UI? | **LEGAL COUNSEL REQUIRED** |
| 5 | What geofencing/geolocation enforcement standard would Brohda be required to implement (IP-only, IP+attestation, IP+KYC), and does that vary by jurisdiction? | **LEGAL COUNSEL REQUIRED** |
| 6 | Minimum age requirement(s) for real-money participation, and how they must be verified | **LEGAL COUNSEL REQUIRED** |
| 7 | Does Brohda have independent KYC/AML obligations distinct from whatever Polymarket itself performs, given Brohda is a distinct legal entity facing the end consumer? | **LEGAL COUNSEL REQUIRED** |
| 8 | Sanctions screening responsibility — Brohda's own OFAC/equivalent obligations, independent of any screening Polymarket performs | **LEGAL COUNSEL REQUIRED** |
| 9 | Restricted-persons handling (PEPs, prior fraud flags, self-exclusion requests analogous to gambling self-exclusion regimes) | **LEGAL COUNSEL REQUIRED** |
| 10 | What Brohda's own Terms of Service must disclose about the relationship to Polymarket, fee structure, and risk of loss | **LEGAL COUNSEL REQUIRED**, drafting is a **FOUNDER DECISION** once counsel sets requirements |
| 11 | Tax/reporting obligations (e.g. issuing consumer tax documents, reporting thresholds) in Brohda's operating jurisdiction(s) | **LEGAL COUNSEL REQUIRED** |
| 12 | Whether the product's legal classification is "prediction market," "gambling/wagering," "commodity/derivatives trading," or another category — this materially changes which regulatory regime applies | **LEGAL COUNSEL REQUIRED** — **this is the single highest-leverage open legal question**, since nearly every other item's answer depends on it |
| 13 | Consumer-protection obligations (cooling-off periods, loss limits, responsible-gambling-style disclosures) if classified as gambling-adjacent | **LEGAL COUNSEL REQUIRED**, contingent on #12 |
| 14 | Cross-border data-transfer/privacy obligations from collecting geolocation/KYC data | **LEGAL COUNSEL REQUIRED** |
| 15 | Record-retention requirements for financial/compliance records | **LEGAL COUNSEL REQUIRED** |
| 16 | Dispute-handling process for a user who disputes an execution outcome | **FOUNDER DECISION** for the product-support process; **LEGAL COUNSEL REQUIRED** for any regulatory minimum |
| 17 | Which specific jurisdictions Brohda will initially target for real execution | **FOUNDER DECISION**, bounded by counsel's answer to #12 and Polymarket's own restrictions (§2.4) |
| 18 | Whether Costa Rica (Brohda's current operating base, per its existing `DEFAULT_TIMEZONE`/legacy product context) is automatically permissible for this product | **NOT ASSUMED — LEGAL COUNSEL REQUIRED.** This milestone explicitly does not assume it, per its own instructions. |
| 19 | Whether builder-fee revenue itself is taxable/reportable as a distinct revenue stream requiring its own treatment | **LEGAL COUNSEL REQUIRED** |
| 20 | Polymarket's own current jurisdiction-restriction list, in full (provider fact, not a legal conclusion, but a required input to #17) | **PROVIDER FACT — not fully confirmed this milestone (§2.4); must be independently re-verified from primary source (full ToS text or direct provider contact) before Milestone 6** |

None of the above is answered by this document. All are surfaced for founder/counsel action.

---

## 6. Execution architecture options

### Option A — User-owned external wallet (EOA or user-controlled Safe)

The user creates and controls their own wallet entirely outside Brohda (MetaMask, Rabby, etc.), funds it independently, and either signs directly in a Brohda-embedded flow (a wallet-connect-style popup) or via a third-party wallet UI.

- **UX**: Worst of the four options for a consumer product with the stated goal "the consumer never needs to understand crypto" (roadmap §1) — the user must install a wallet extension, manage seed phrases, and bridge/acquire the collateral asset independently.
- **Custody risk to Brohda**: None — Brohda never touches funds or keys.
- **Key-management burden**: Entirely on the user; Brohda has zero exposure but also zero ability to help a user who loses access.
- **Recovery**: Whatever the user's own wallet provider offers; Brohda cannot assist.
- **Legal/compliance implications**: Likely the *lightest* custody-related burden (Brohda never possesses funds or keys), but does not eliminate the "is Brohda an intermediary/broker" question (§5 #1) merely because custody is absent.
- **Provider compatibility**: Fully compatible — this is Polymarket's own EOA/Safe-legacy model.
- **Implementation complexity**: Moderate (wallet-connect integration, no session-key/relayer complexity).
- **Fraud/support risk**: Users self-manage; support burden shifts to "how do I use MetaMask," a real but bounded cost.
- **Vendor dependency**: A wallet-connect library, not a custody vendor.
- **Crypto visibility to consumer**: **High** — directly conflicts with the roadmap's stated product principle. This is this option's single biggest weakness for Brohda specifically.

### Option B — Embedded non-custodial wallet

A wallet is provisioned inside the Brohda UX (e.g. via an embedded-wallet vendor such as Privy, Dynamic, or Magic — Polymarket's own legacy "Proxy Wallet" model already uses Magic Link), but signing keys remain user-controlled (often via a passkey/email-recovery model) or split via MPC/threshold signing with the vendor.

- **UX**: Much better — no seed phrase, no extension, can look like an ordinary login.
- **Custody risk to Brohda**: Depends entirely on the vendor's architecture — a poorly-chosen vendor could make this functionally custodial despite being marketed as "non-custodial." This is a real due-diligence burden, not a solved problem.
- **Key-management burden**: Shifts to the embedded-wallet vendor; Brohda inherits vendor-selection and vendor-risk responsibility instead of building key management itself.
- **Recovery**: Vendor-dependent (email/passkey/social recovery common) — generally much better UX than Option A, but introduces a new recovery-fraud surface (account-recovery social engineering).
- **Legal/compliance implications**: Ambiguous and vendor-dependent — some embedded-wallet architectures are treated as non-custodial for regulatory purposes, others are not; **this is exactly the kind of determination that needs counsel input on the *specific* vendor chosen**, not a general architecture-level answer.
- **Provider compatibility**: Compatible with Polymarket's Proxy Wallet/Deposit Wallet model.
- **Implementation complexity**: Moderate-to-high (vendor SDK integration, recovery flows).
- **Vendor dependency**: **High** — a genuine third-party dependency for a security-critical function.
- **Crypto visibility to consumer**: **Low** — can be made nearly invisible, closely matching the roadmap's product goal.

### Option C — Delegated signing / Session Keys (Polymarket-native)

The user holds a Polymarket Deposit Wallet (created however — possibly itself via Option B's embedded flow for the *initial* wallet, or a simpler onboarding); Brohda requests a Session Key scoped to `CLOB` trading, time-limited to (at most) 180 days.

- **UX**: Can be very good if paired with a simple wallet-creation flow — the ongoing trading experience needs no further signing prompts within the session window.
- **Custody risk to Brohda**: **Session Key material must exist somewhere Brohda's backend can use it to sign order requests on the user's behalf** — this is a real secret Brohda would hold, even though it is explicitly *not* capable of withdrawing funds (§2.3, provider-confirmed). This is a materially smaller blast radius than full custody, but it is not "zero risk."
- **Key-management burden**: Brohda must securely store and use one Session Key secret per user — a genuine, non-trivial secrets-management obligation (§9, §11).
- **Recovery**: If a Session Key is lost/compromised, the user's Deposit Wallet owner can revoke and re-authorize — recovery does not depend on Brohda at all, which is a meaningful advantage over Option D.
- **Legal/compliance implications**: Brohda would be signing/submitting orders "for" the user within a scoped delegation — §5 #4's question (does holding signing material create an agency/fiduciary relationship) is squarely triggered by this option specifically.
- **Provider compatibility**: **Directly, natively supported by Polymarket today** (§2.3) — the only option of the four with an explicit, documented, currently-shipping provider mechanism built for exactly this use case.
- **Implementation complexity**: Moderate — no need to build custody infrastructure, but does require secure session-key storage/rotation and a real understanding of the 180-day expiry/revocation lifecycle.
- **Fraud risk**: Bounded by the "cannot withdraw funds" guarantee, but a compromised key can still place harmful trades within its scope until revoked.
- **Vendor dependency**: None beyond Polymarket itself.
- **Crypto visibility to consumer**: Depends on how the underlying Deposit Wallet is created — if paired with an embedded-wallet-style onboarding (effectively Option B for wallet creation, Option C for ongoing trading authority), visibility can be kept low.

### Option D — Custodial wallet/account

Brohda (or a custody vendor Brohda contracts) holds the private keys / signing authority outright, on behalf of all users, in an omnibus or per-user custodial structure.

- **UX**: Best possible — completely invisible to the user, closest to a traditional fintech balance.
- **Custody risk to Brohda**: **Maximum.** Brohda (or its custody vendor) is a single point of failure for all user funds simultaneously.
- **Key-management burden**: Maximum — full custody-grade key management (HSMs or equivalent, multi-party approval for movement, etc.) is required to do this responsibly at all.
- **Recovery**: Brohda-mediated entirely — good for the user (no seed phrases to lose) but places 100% of the operational burden and 100% of the blast radius on Brohda.
- **Legal/compliance implications**: **Almost certainly the heaviest regulatory burden of the four** — custody of customer funds is the paradigm case that triggers money-transmitter/custodian licensing regimes in most jurisdictions this task is aware of as a general matter (not a jurisdiction-specific legal conclusion — see §5 #3).
- **Provider compatibility**: Would require Brohda to operate as effectively a single mega-account or omnibus structure against Polymarket, allocating positions internally — **not a documented, provider-native pattern** in anything fetched this milestone; would need direct provider engagement to confirm feasibility at all.
- **Implementation complexity**: Highest.
- **Vendor dependency**: High if using a third-party custodian; total internal ownership of the hardest security problem if not.
- **Crypto visibility to consumer**: None.

---

## 7. Technical recommendation

**Technical preference**: **Option C (Session-Key delegated signing on a Deposit Wallet), with the initial Deposit Wallet itself provisioned through an embedded-wallet-style onboarding flow (borrowing Option B's UX for wallet creation only, not for ongoing trading authority).**

**Reason**: This is the only option that is simultaneously (a) natively, currently supported by Polymarket with a documented security model (§2.3) rather than a novel or unconfirmed integration pattern; (b) structurally incapable of fund withdrawal even under full compromise, which is the single largest blast-radius reduction available among the four options; (c) compatible with a low-crypto-visibility consumer UX when the initial wallet-creation step is smoothed over; and (d) does not require Brohda to build or operate custody-grade infrastructure (Option D) or take on an unbounded, architecture-dependent vendor-trust question for the ongoing trading relationship (Option B alone, for the *trading* authority rather than just wallet creation).

**Final decision status**: **BLOCKED pending legal/compliance review.** Session-key delegation is exactly the architecture that squarely raises §5 question #4 (does holding signing material create an agency/fiduciary relationship) and is inseparable from §5 questions #1–#3 more broadly. The technical case for Option C is strong; **it is not a legally cleared decision**, and this document does not claim it is. See Decision Register (§15) items 1–3, all marked `BLOCKED`/`COUNSEL REQUIRED`, not `LOCKED`.

---

## 8. Wallet/account model (conceptual, not implemented)

| Question | Answer (architecture only — not implemented) |
|---|---|
| Does every user need a provider-compatible wallet? | Only once real execution (Milestone 6) is reached — Milestones 1–4 (discovery, Predictions) never require one, and this remains true through Milestone 5's simulation (§16). |
| When is it created? | Proposed: lazily, the first time a user attempts a real-money action, not at signup — consistent with the roadmap's "every screen earns its place" principle. |
| Who controls it? | The user (Deposit Wallet owner), per the recommended architecture (§7). |
| Who can sign? | The user directly, or Brohda via a scoped, time-limited Session Key the user has explicitly authorized — never an unscoped or permanent Brohda signing authority. |
| Recovery | Provider/wallet-layer question, not a Brohda-built system under the recommended architecture — but the *onboarding* vendor (if an embedded-wallet-style flow is used for wallet creation) would own real recovery-UX responsibility, itself a vendor-selection question (§10 legal item aside). |
| Is wallet identity visible to the consumer? | Recommended: no, by default — matches the roadmap's "no wallet word in the UI" open question (§9 OPEN #4) leaning toward hiding it, though that remains an explicit **OPEN** roadmap item, not decided here. |
| Are funds deposited to Brohda, or directly to a provider-compatible wallet? | Recommended: directly to the user's own Deposit Wallet — Brohda is never a deposit intermediary under Option C. |
| Does Brohda ever custody funds? | **No**, under the recommended architecture. |
| Does Brohda ever hold signing keys? | **Session Key material only**, under explicit, revocable, time-limited, fund-withdrawal-incapable delegation — not the user's primary key. This is still real secret material Brohda would hold (§9). |
| Can account linkage be revoked? | Yes — Session Key revocation is user-controlled and provider-native (§2.3). |
| What happens if the provider account/wallet becomes inaccessible? | Not Brohda's to solve — this is the provider/wallet layer's own recovery responsibility; Brohda's Prediction history (already permanent, per Milestone 3) is entirely unaffected either way, since Predictions never depend on wallet state (§11). |

---

## 9. Key-management / signing threat model (summary — full model in `docs/security/execution-threat-model.md`)

For the recommended architecture (Option C), the only new secret material Brohda's backend would ever hold is **a per-user Session Key**, scoped to CLOB trading, expiring within 180 days, and — critically — **incapable of withdrawing funds** even if fully compromised (a provider-enforced guarantee, §2.3). This one property is the load-bearing fact that makes Option C's blast radius categorically smaller than Option D's (where the compromised secret controls the entire fund). It does **not** make Option C risk-free — a compromised Session Key can still place harmful trades within its scope until revoked, and revocation is not instantaneous (asynchronous cancellation described as taking "minutes"). Full actor-by-actor, asset-by-asset analysis (server compromise, DB compromise, malicious admin, leaked builder credential, replay, quote/market-ID substitution, etc.) is in the dedicated threat-model document (§14 of this document references it; full content in `docs/security/execution-threat-model.md`).

**If any future design would require Brohda to store a user's raw primary private key** (true for Option D, and for a poorly-designed Option B): treated per this task's own instruction as a major risk, **not approved here**, and would require its own dedicated security review before any implementation begins — this document does not pre-approve that path under any circumstance.

---

## 10. Provider-neutral execution architecture (conceptual contracts only — not implemented)

```
Brohda domain (Prediction, future Order/Position)
        ↓
Provider-neutral execution layer   (ExecutionProvider interface — conceptual)
        ↓
Polymarket execution adapter        (isolates CLOB order/signature shapes, builder codes, Session Key mechanics)
        ↓
Polymarket CLOB / Session Key / Relayer infrastructure
```

This mirrors Milestone 1's own already-proven pattern (`PredictionMarketProvider`, `lib/prediction-markets/types.ts`) exactly — one clean interface, one provider today, room for a second later, never built out further than that (roadmap §2's own explicit non-goal). The following are **conceptual contracts only**, documented so Milestone 5 has a shape to implement against — **no code, no table, no interface file is created by this milestone** (per Step 35's explicit instruction):

- **`ExecutionProvider`** — the provider-neutral interface a future adapter implements: `isEnabled()`, `getQuote(marketId, side, amount)`, `submitOrder(intent)`, `cancelOrder(orderId)`, `getOrderStatus(orderId)`, `getFills(orderId)`. No CLOB-specific field name (`tokenId`, `makerAmount`, `signatureType`, `builder`) may appear above this boundary — exactly the discipline already proven for `NormalizedMarket` in Milestone 1.
- **`ExecutionAccount`** — the provider-neutral representation of "this user's ability to trade" (wallet linkage state, eligibility state, Session Key validity) — never exposes a raw wallet address or key material to Brohda consumer code.
- **`Quote`** — see §12.
- **`OrderIntent`** — Brohda's own record of "the user asked to do X," created *before* any provider submission, so a submission failure/timeout has something durable to reconcile against (§17).
- **`Order`** — the provider-facing submitted order and its lifecycle state (mapped from CLOB's `live`/`matched`/`delayed`/`unmatched` and trade statuses `MATCHED`/`MINED`/`CONFIRMED`/`RETRYING`/`FAILED` into a provider-neutral vocabulary — §19).
- **`Fill`** — one matched execution event against an `Order`.
- **`Position`** — the resulting financial exposure (Milestone 7's own domain to fully realize; not built here).
- **`Settlement`** — the resolution/redemption event closing a `Position`.

---

## 11. Prediction vs. Order vs. Position — rigorous separation

This is a restatement and extension of `docs/architecture/prediction-layer.md` §2, for the execution domain specifically:

- **Prediction** (exists today, Milestone 3): a permanent record of belief. Immutable snapshot, no financial exposure, no dependency on any Order or Position ever existing. **A Prediction must never be modified, voided, or reinterpreted by a future Order/Position existing or changing state.**
- **Order** (future, Milestone 6): an instruction to acquire/reduce exposure. **An Order MAY reference the Prediction that motivated it** (e.g. "the user's Order was placed because they held Prediction X") for UX/analytics linkage, but a Prediction's own permanence must never be implemented as a foreign-key-cascaded child of an Order — the soft-reference, snapshot-based preservation pattern Milestone 3 already established for Prediction→Market (`docs/architecture/prediction-layer.md` §4) is the template to reuse for any future Order→Prediction linkage, not a hard dependency.
- **Fill/Trade** (future, Milestone 6): one provider execution event against an Order. Never itself a source of Prediction correctness — Prediction grading (Milestone 3) already reads only the normalized Market's resolution, never order/fill data, and this must remain true even once Orders exist (a user could in principle predict without ever placing a matching real Order, and the two must stay independently gradable/valid).
- **Position** (future, Milestone 7): the resulting financial exposure. **Closing or settling a Position must never erase or alter Prediction history** — this is a hard requirement carried directly from this task's own instructions, and it is architecturally trivial to satisfy given Prediction's existing independence (§2/§4 of `prediction-layer.md`), provided no future implementation is tempted to "clean up" a Prediction when its associated Position closes. Flagged explicitly here so a future Milestone 6/7 implementer does not casually violate it under time pressure.

---

## 12. Future Quote architecture (conceptual fields only — no code)

A future `Quote` (Milestone 5) conceptually needs:

| Field | Purpose |
|---|---|
| `marketId` | Which Brohda market (soft reference, same pattern as Prediction). |
| `side` | YES/NO — reusing Prediction's own closed outcome vocabulary, not a new one. |
| `requestedAmount` | What the user typed/selected. |
| `impliedPrice` | The current provider-derived probability at quote time. |
| `estimatedUnits` | Internal-only; never a consumer-facing "shares" concept (roadmap STEP 26's vocabulary discipline applies to real execution too). |
| `estimatedGrossReturn` | What §22 requires showing the user. |
| `estimatedFees` | Provider fee + Builder fee + Brohda fee, itemized (§13). |
| `estimatedSlippage` | How much the price might move between quote and fill. |
| `providerQuoteTimestamp` | When the underlying price was actually observed. |
| `expiresAt` | When this Quote stops being honorable — see the stale-quote discussion below. |
| `providerLiquidityContext` | Enough order-book depth context to know if the requested size is realistic against current liquidity (diagnostic, not necessarily consumer-facing). |
| `stale` | A boolean/enum, exactly mirroring Milestone 2's own `Freshness` pattern (`FRESH`/`STALE`/`UNAVAILABLE`) — reused conceptually, not literally the same type, since a Quote's staleness tolerance is almost certainly tighter than a discovery feed's. |

**Consumer UX implication**: exactly the roadmap's own example (`$10 → potential return $16.13`) — the belief (YES/NO) stays visually and sequentially first, the arithmetic stays honest and secondary, never the headline (roadmap §4). No Quote code is implemented by this milestone; this is a documentation artifact only, satisfying Step 12's "pure type/spec artifact... for documentation" allowance without crossing into implementation.

---

## 13. Fee model (conceptual — no numeric fees hard-coded, none proposed)

Distinguished cost components for a future real Order:

| Component | Source | When known |
|---|---|---|
| **Provider fee** | Polymarket itself (the CLOB's own maker/taker economics — the pages fetched this milestone did not surface a separate "Polymarket platform fee" distinct from the builder fee mechanism itself; this needs direct confirmation before Milestone 6, not assumed absent) | At quote time, refined at fill time |
| **Builder fee** | Brohda's own registered builder rate — **provider-capped** at 0–100 bps taker / 0–50 bps maker (§2.2), but the *actual* rate within that range is entirely Brohda's own configurable choice | Known exactly at quote time, since it's set by Brohda's own builder registration, not the market |
| **Network/gas cost** | Not applicable under the Deposit Wallet model (Relayer submits gaslessly, per §2.3) — but this must be re-confirmed for whichever wallet model is ultimately approved, since gas cost is a real, user-visible line item under the legacy EOA model | Known only if a gas-paying wallet model is ever chosen |
| **Brohda fee** | If Brohda charges beyond its builder-fee revenue — **not decided here**, a pure founder/business decision, and if ever implemented must be configuration-driven, never hard-coded (per the standing rule, explicitly called out for Milestone 4 in the task's own instructions) | Founder decision, not yet made |
| **Spread/slippage** | Market-derived, estimated at quote time, only exactly known at fill time | Estimated pre-trade, reconciled post-fill |
| **Total estimated user cost** | Sum of the above, shown pre-confirmation per §22 | At quote time (estimate), reconciled at fill (actual) |

**Disclosure**: must show the *total* estimated cost before any future confirmation step, consistent with the roadmap's own preserved "money becomes prominent at exactly two moments — committing and settling — with full transparency" principle (roadmap §4 PRESERVE list). **Reconciliation**: actual fees at fill time may differ from the quote-time estimate (real slippage, real fill price) — a future implementation must show the user the *actual* cost at confirmation of a completed trade, not silently rely on the earlier estimate (this is a reconciliation-architecture concern, §18/§19, not just a UI concern). **No numeric fee rate is proposed, chosen, or hard-coded by this document** — every fee value is explicitly deferred to future configuration, per this milestone's own standing-rule emphasis.

---

## 14. Geofencing architecture (conceptual, server-enforced only — not implemented)

```
Request
  → authenticated user (existing requireUser())
  → jurisdiction/geolocation eligibility          [NEW conceptual layer — not built]
  → provider eligibility (Polymarket's own geo-block, §2.4)
  → execution eligibility (KYC/age/sanctions state, if required by counsel — §5)
  → Quote / Order
```

Possible signals (none implemented, all conceptual): declared account country, IP geolocation (would need a provider — see §12 of the task/§17 below), a provider-returned geofence result (if Polymarket exposes one — not confirmed this milestone), a KYC vendor's result, sanctions-screening vendor result, age-verification result. **Execution geofencing must ultimately be enforced server-side, exactly mirroring this codebase's own existing discipline** (every Milestone 1–3 eligibility check — discovery, Prediction submission — is server-enforced, never client-only; see `lib/predictions/policy.ts`'s `checkMarketEligibility`, itself never trusted from a client). Mutable geography (which countries are allowed/blocked) must be **configuration or provider-policy data**, never a hard-coded list in application code — directly per this task's own explicit emphasis on this exact risk. No such configuration table is created by this milestone (Step 35).

---

## 15. Execution kill switch (conceptual — not implemented)

A future kill switch needs, at minimum, independently toggleable scopes:

- **Global** execution off (all providers, all markets, all users)
- **Provider-specific** off (e.g. Polymarket only, if a second provider ever exists)
- **Jurisdiction-specific** off
- **Market-specific** off (e.g. a single market pulled for a data-quality or legal reason)
- **User/cohort-specific** off (e.g. suspected fraud, an ongoing dispute)

**Architecturally, this is the same shape as `platform_settings`' already-proven pattern** (`registration_enabled`, `paid_pools_enabled`, `free_pools_enabled`, and now `prediction_allow_*`/`prediction_notify_*` from Milestones 2–3) — a boolean (or small set of booleans/rows) read live, server-side, on every relevant request, changeable without a deployment. **This capability is a hard prerequisite for Milestone 6** (§17) — no real-execution milestone may launch without it already built and tested, per this task's own explicit instruction. Not built here.

---

## 16. Rollout / cohort architecture (conceptual — not implemented)

Future policy dimensions, all of which must be configuration-driven (never hard-coded), mirroring the kill-switch discipline above:

- User allowlist (explicit list of eligible user IDs)
- Percentage-based cohort rollout
- Jurisdiction-based rollout
- Provider-based rollout (if multiple providers ever exist)
- Admin-approved / internal-tester flag
- Per-user maximum order amount
- Per-user/cohort daily exposure limit

This is the same "controlled cohorts and feature flags, never a full unguarded rollout" principle the roadmap already locks for "high-risk milestones (5 onward, especially 6)" (roadmap §11 item 12). Not built here — documented so Milestone 6 knows the shape it must build before launch, per §17.

---

## 17. Future order idempotency contract (conceptual — reusing, not assuming, existing patterns)

This codebase already has a proven idempotency pattern (`create_pool_entry`'s idempotency-key + unique-constraint + exception-handler fallback, reused again for Prediction creation in Milestone 3 without a `SECURITY DEFINER` function). A future Order system must define its own contract, explicitly **not** assuming the internal-ledger semantics of that pattern map directly, because a provider round-trip (network timeout, partial response) is a fundamentally different failure mode than a same-database transaction:

- **One client-generated intent/request ID** per user action, carried through the whole flow.
- **One Brohda `OrderIntent` row** created *before* any provider call — this is what makes a timeout recoverable (§18): if Brohda never hears back from the provider, it has a durable record of what was *attempted*, and can reconcile against the provider's own order/fill state rather than guessing.
- **One provider submission identity** (the provider's own order ID) recorded once known.
- **Retries must never create a duplicate provider order** — this requires the retry path to first check "did my last attempt actually reach the provider" (via a provider order-status lookup keyed by the same intent, if the provider supports idempotent order IDs — not confirmed this milestone whether Polymarket's CLOB does; **OPEN, verify before Milestone 6**) rather than blindly resubmitting.
- **A timeout must never be treated as a failure outright** — per §18, the provider may have accepted the order even though Brohda's own request timed out; the correct response is reconciliation (a status lookup), not an automatic assumption of success or failure.
- **Partial fills are a distinct, non-error state**, not a failure — matching the CLOB's own documented model (§2.1) where a partially-filled order's remainder can still be cancelled independently.
- **Canceled vs. rejected vs. expired must be distinguished** in Brohda's own vocabulary (§19), not collapsed into one generic "failed" state, since each implies different user messaging and different reconciliation action.

---

## 18. Reconciliation architecture (conceptual — not implemented)

**Core principle, restated from this task's own instruction and already consistent with this codebase's existing discipline (Milestone 3's own grading never fabricates a result before authoritative resolution)**: **Brohda must never declare financial state purely from optimistic UI state.** The provider is the source of truth for order/fill/position state; Brohda's own `OrderIntent`/`Order` records are a durable *record of what Brohda believes*, reconciled against the provider, never the other way around.

Source-of-truth hierarchy (proposed):
1. **Provider's own order/fill/position state** (via status lookup / activity API) — authoritative.
2. **Brohda's `Order`/`Fill` records** — a cache/mirror of #1, kept in sync by polling and/or provider events, never authoritative on its own.
3. **Brohda's `OrderIntent`** — the durable record of user intent, used to reconcile against #1 when Brohda's own state is uncertain (timeout, missed event).

Scenarios to design for (documented here, not solved in code):
- **Submission timeout**: reconcile via a status lookup before ever retrying or telling the user it failed.
- **Provider accepts but Brohda misses the response**: same remedy — poll/lookup by the known intent before assuming anything.
- **Provider rejects**: surface a user-correctable failure (§19) if the rejection reason is user-fixable (e.g. insufficient balance), else a provider-temporary or reconciliation-required class.
- **Partial fill, multiple fills**: aggregate correctly into one `Order`'s fill history; never let a partial fill look like either "nothing happened" or "fully filled."
- **Cancel races**: mirrors the CLOB's own documented delay-window behavior (§2.1) — a cancel attempted during a delay window may lose the race to a match; Brohda must handle "my cancel was rejected because the order already matched" as a distinct, expected outcome, not an error.
- **Settlement/position changes, provider corrections**: Milestone 3's grading already establishes the precedent of **not** retroactively re-processing an already-finalized record when upstream state changes later (`docs/architecture/prediction-layer.md` §13) — a future Position/Settlement reconciliation system should consciously decide whether to inherit that same "no automatic retroactive correction" posture or explicitly diverge from it, but must not silently assume one or the other.
- **Provider outage, webhook/event loss**: a polling fallback must exist independent of any webhook/event mechanism — never rely solely on push events for financial state.
- **User wallet balance mismatch**: under the recommended architecture (Option C), Brohda never holds the balance itself, so "mismatch" here means Brohda's *cached view* of the user's tradeable balance disagreeing with the provider's — resolved by re-querying the provider, never by trusting Brohda's cache.

---

## 19. Failure-state vocabulary (conceptual, provider-neutral — not implemented)

Derived, not copied wholesale from the CLOB's own status names (§2.1), and classified by required handling:

| Brohda-level state | Meaning | Class |
|---|---|---|
| `PROVIDER_UNAVAILABLE` | Provider unreachable/erroring | provider-temporary |
| `QUOTE_STALE` | The quote backing this action has expired | user-correctable (re-quote) |
| `MARKET_CLOSED` | Market no longer accepts new orders | user-correctable (reroute to another market) |
| `NOT_ELIGIBLE` | Geofencing/KYC/age/sanctions gate failed | user-correctable only if the underlying reason is (e.g. re-verify age); otherwise a hard stop |
| `INVALID_AMOUNT` | Amount fails a validation rule (min size, precision) | user-correctable |
| `ORDER_REJECTED` | Provider rejected the order for a reason Brohda can classify | depends on reason — some user-correctable (insufficient balance), some not |
| `ORDER_TIMEOUT` | No response received in time | **reconciliation-required**, never auto-classified as success or failure (§18) |
| `PARTIAL_FILL` | Order partially executed | not a failure at all — a normal, distinct state |
| `SIGNING_FAILED` | The signing step itself failed (e.g. expired/revoked Session Key) | security-critical if unexpected; user-correctable if the key simply expired (re-authorize) |
| `RECONCILIATION_REQUIRED` | Brohda's own state cannot currently be trusted against the provider | **security/financial-critical** — must never be silently resolved by guessing |

**Consumer-facing translation**: exactly the discipline already established for Prediction ineligibility copy (`lib/predictions/copy.ts`) — never a raw provider error message or internal state name shown to a user; each state maps to plain-language copy, centralized in one place, never duplicated across the codebase.

---

## 20. Secrets architecture (conceptual — no real secrets, no placeholders added)

Future secret categories: Builder API/registration credentials; Provider API credentials (L1/L2, §2.1) if any are held server-side rather than per-user; Session Key material (per-user, if Option C is ultimately approved); webhook signing secrets, if webhooks are used.

Required properties (documented, not implemented): storage in the existing secrets mechanism this codebase already uses for `SUPABASE_SERVICE_ROLE_KEY`/Sentry auth tokens (environment variables outside the repo, `.env.local`/hosting-provider secret store — **never** the database, unless a specific future architecture review explicitly approves a database-backed secret for a stated reason); encryption at rest wherever the hosting platform's own secret store provides it; runtime access restricted to the minimum server-side code path that needs it (never client-bundled, mirroring this codebase's existing `server-only` package discipline already used throughout `lib/predictions/*`/`lib/prediction-markets/*`); strict separation between local/dev and production credential sets (already an established pattern — `TEST_SUPABASE_*` vs. production vars, per `tests/integration/helpers/test-env.ts`'s own hard-won lesson from a prior incident); logging must never include secret material or raw signatures, only correlation IDs and outcome; a defined rotation and revocation path for every credential type — for Session Keys specifically, this is provider-native (§2.3); least-privilege scoping (a Session Key scoped to `CLOB` only, never `All`, unless a specific feature genuinely needs Combos). **No secrets, real or placeholder-shaped, are added by this milestone.**

---

## 21. Observability / audit requirements (conceptual — not implemented)

Required future audit events (mirroring the granularity already established for `audit_logs`/Prediction grading's own event model): quote requested; order intent created; eligibility checked (with the specific gate that passed/failed); signing attempted; provider submission; provider acknowledgement; fill; partial fill; cancellation; rejection; reconciliation performed; position update; settlement; user-visible notification sent; admin override; kill-switch invoked. **Never logged**: private keys, raw signatures (sensitive by nature even if not directly fund-moving), full auth credentials, any full secret-bearing payload. **Correlation IDs**: the `OrderIntent`'s own client-generated ID (§17) should thread through every subsequent event for that order, exactly mirroring how this codebase already correlates a Prediction's `id` through its own creation→grading→notification chain.

---

## 22. User-visible transparency requirements (conceptual — no UI built)

Before any future real confirmation step, the user must see: the selected market/question; YES/NO side; amount; current probability/price; expected return; estimated total fees (§13, itemized or at minimum totaled); a slippage/price-movement warning if applicable; the quote's expiry; any eligibility constraint already known (e.g. "trading closes in your region soon" style honesty, not silent failure); and a clear, explicit confirmation step. No unnecessary exchange jargon (roadmap STEP 26's vocabulary discipline, unchanged for real execution) — the user should never need to understand crypto to complete this flow, exactly the product principle this whole transformation is built around.

---

## 23. Provider outage behavior (conceptual — not implemented)

Discovery (Milestone 2) can and should continue serving cached normalized data during a provider outage — this is already true today and remains true. Predictions (Milestone 3) may continue accepting submissions during an outage **according to already-existing configurable policy** (`prediction_allow_stale_price`/`prediction_allow_unavailable_price` — no change needed, no change proposed). **Financial quote/execution must disable itself the moment provider state cannot be trusted** — never submit a real order against a stale quote past its expiry, and never assume a failed HTTP call equals a failed order (§18's reconciliation principle again). A future circuit-breaker (e.g. N consecutive provider failures → auto-disable execution until manually or automatically cleared) is the natural mechanism, and its thresholds must be configuration, not hard-coded, per the standing rule.

---

## 24. Rate-limiting strategy (decision made now, not implemented now)

This codebase's existing rate limiter (`lib/rate-limit/entries.ts`, referenced in Milestone 3's own research) is documented elsewhere in this codebase as failing **open** under DB failure — acceptable for a FREE Prediction submission (no money at stake) but **explicitly unacceptable for order submission**, per this task's own instruction. **Decision, made now as architecture (not implemented now)**: any future execution rate limiter must **fail closed** — a rate-limiter infrastructure failure must block order submission, not silently allow unlimited submission. This is a deliberate, documented divergence from the existing Prediction-tier rate limiter's own fail-open posture, justified specifically by the presence of real financial exposure. Separate rate-limit classes are needed for: discovery (existing, unaffected), Prediction submission (existing, unaffected, stays fail-open), quote generation, order submission, cancellation, and admin financial actions — each independently configurable, none of their numeric values chosen or hard-coded by this document.

---

## 25. Funding / balance model

**Explicit answers, as this task requires, rather than a silent assumption:**

- **Is legacy wallet balance separate from future execution balance?** **Yes, entirely separate**, under the recommended architecture (Option C) — the legacy `wallet_balances`/`wallet_transactions` tables represent Brohda's own internal USD ledger for the legacy pari-mutuel pool product; a future execution balance (whatever the user holds in their own Deposit Wallet, off-platform) is a completely different asset, a different currency (fiat-pegged internal ledger vs. Polymarket's collateral asset, §1's flagged discrepancy notwithstanding), and a different custody model (Brohda-adjacent internal ledger vs. user-controlled external wallet). **These must never be merged or treated as fungible.**
- **Does Brohda's internal ledger represent real provider funds?** **No** — the legacy ledger has never represented anything other than Brohda's own internal pari-mutuel accounting; it has no relationship to Polymarket collateral today and none is proposed here.
- **Will legacy balances ever migrate?** **Not decided — remains an explicit roadmap OPEN item** (roadmap §9 OPEN #5: "How existing Brohda internal ledger balances... ultimately transition — migrated into the new model, cashed out, or left to resolve naturally under the legacy engine until Milestone 9"). This milestone does not resolve it, consistent with the roadmap's own framing of it as unresolved.
- **Is a bridge needed?** Only if a future founder decision chooses migration over "cash out" or "resolve naturally" — not decided here, and no bridge architecture is proposed since doing so would presuppose an unmade decision.
- **What happens to current deposits/withdrawals?** **Unaffected.** The legacy pool engine remains fully operational per the roadmap's own locked coexistence principle (roadmap §6/§11 item 2) — nothing in this milestone touches, gates, or degrades it.

---

## 26. Legacy internal wallet analysis

Inspected (read-only, this milestone): `wallet_balances`, `wallet_transactions`, the deposit/withdrawal request flow (`wallet-requests` actions), and admin reconciliation surfaces already present in this codebase.

**Reusable as pattern, not as shared state**:
- The **idempotency-key + unique-constraint + exception-handler-fallback** pattern (`create_pool_entry`, already reused once for Prediction creation in Milestone 3 without needing a `SECURITY DEFINER` function) is directly reusable as a *pattern* for `OrderIntent` creation — but a provider round-trip's failure modes (§17/§18) are richer than a same-database RPC's, so the pattern needs extension, not verbatim reuse.
- The **audit-log-on-every-mutation** convention (`writeAuditLog`, before/after snapshots) is directly reusable as a pattern for every future execution event (§21).
- The **service-role-mutation-only, RLS-restricts-reads** convention (proven across `predictions`, `capability_policies`, `discovery_categories`) is directly reusable for any future `orders`/`order_intents` table, whenever one is actually built (not by this milestone).

**Must remain completely separate, not reused as shared state**:
- `wallet_balances`/`wallet_transactions` themselves must **not** become the ledger for provider-held funds — a real Deposit Wallet's balance is verifiable only by asking the provider (§18's source-of-truth hierarchy), never by trusting an internal Brohda number the way the legacy pari-mutuel ledger's balance is trusted today (which is valid *because* Brohda is the pari-mutuel counterparty and oracle for that product — a role the new product explicitly does not have per the roadmap's core pivot, §1).
- Admin reconciliation UX patterns for the legacy wallet (manual deposit verification against a block explorer, per the audit's own documented posture) are a *precedent for caution*, not a template to copy verbatim — a real execution reconciliation system needs provider API-driven reconciliation (§18), not a manual admin-verification-only model, given the expected volume and latency requirements of live trading.

---

## 27. External vendor requirements (research-only — no vendor selected, no account created)

| Capability | Vendor category (if pursued) | Required now? | Can Milestone 5 proceed without selecting one? |
|---|---|---|---|
| Embedded wallet (if Option B is used for wallet creation under the recommended architecture) | Embedded-wallet-as-a-service (e.g. the general category Privy/Dynamic/Magic occupy — Polymarket's own legacy Proxy Wallet already uses Magic Link, per §2.3) | No | **Yes** — Milestone 5 has no real wallet at all (§16 of the roadmap's own Milestone 5 scope: "quote/preview logic... stopping short of calling the provider's order-submission API") |
| KYC/age verification | Identity-verification vendor category | No | **Yes** — no real eligibility gate is needed until real money is at stake |
| Sanctions screening | Compliance-screening vendor category | No | **Yes**, same reasoning |
| Geolocation | IP-geolocation vendor category (could reuse a general-purpose provider; no specific vendor researched this milestone) | No | **Yes** |
| Custody (only if Option D is ever chosen instead of the recommendation) | Institutional custody vendor category | No — and only relevant at all if the recommended architecture (§7) is overridden | N/A under the current recommendation |

**No vendor was researched by name, contacted, or signed up with this milestone** — per the task's own explicit instruction not to choose vendors based on guesswork and not to create real accounts. This table exists to confirm Milestone 5 genuinely does not need any of these resolved first (§16).

---

## 28. Architecture decision matrix

| Dimension | A: External wallet | B: Embedded non-custodial | C: Session-Key delegated (recommended) | D: Custodial |
|---|---|---|---|---|
| Custody model | None | Vendor-dependent, ambiguous | None (session-scoped delegation only) | Full |
| Signing authority | User only | User (or vendor-assisted) | User grants scoped, revocable, non-withdrawal delegation | Brohda/custodian |
| User UX | Poor (seed phrases, extensions) | Good | Good, if wallet creation is smoothed over | Best |
| Crypto visibility | High | Low | Low-to-moderate | None |
| Provider compatibility | Native (legacy EOA/Safe) | Native (legacy Proxy Wallet uses this pattern) | **Native, currently documented, purpose-built** | Not a documented provider pattern — unconfirmed feasibility |
| Security burden on Brohda | Minimal | Vendor-selection risk | Session-Key storage, bounded blast radius | Maximum |
| Legal/compliance burden | Likely lightest | Vendor-architecture-dependent | Triggers agency/fiduciary question directly | Likely heaviest (custody-license-adjacent) |
| Recovery | User's own problem | Vendor-mediated | Provider-native (revoke/reauthorize), not Brohda's problem | Brohda's full responsibility |
| Vendor dependence | Low | High | None beyond the provider itself | High (if outsourced) or fully internal (if not) |
| Implementation complexity | Moderate | Moderate-high | Moderate | Highest |
| Operational complexity | Low for Brohda | Moderate (vendor integration/monitoring) | Moderate (key lifecycle, rotation, revocation) | Highest |
| Blast radius of full compromise | None to Brohda | Vendor-dependent, potentially high | Bounded — cannot withdraw funds | Total |
| Cost | Low | Vendor fees | Low (no vendor required) | Highest (custody-grade infra or vendor fees) |
| Time-to-launch | Fast technically, but conflicts with product UX goals | Moderate (vendor integration + due diligence) | Moderate (provider-native, less novel integration risk) | Slowest (custody buildout or vendor contracting) |
| Reversibility | Trivial (no Brohda-side state) | Moderate (vendor migration is real work) | High (revoke a Session Key at any time) | Low (unwinding custody is operationally hard) |

This is qualitative by design, per this task's own explicit instruction against a meaningless numeric score — the recommendation (§7) is not a score-sum, it is the judgment that Option C is the only option combining provider-native support, bounded blast radius, and a plausible low-crypto-visibility UX without requiring a new custody-grade security program or an unbounded vendor-trust decision.

---

## 29. Decision Register

| # | Decision | Status |
|---|---|---|
| 1 | Custody model | **BLOCKED** — technical preference is "none" (Option C), pending legal/compliance review (§5 #1, #3, #4) |
| 2 | Wallet ownership | **BLOCKED** — technical preference is user-owned Deposit Wallet, pending the same review |
| 3 | Signing model | **BLOCKED** — technical preference is Session-Key delegation, pending §5 #4 specifically |
| 4 | Provider account model | **PROVIDER CONFIRMED** for the mechanism (Deposit Wallet + Session Keys exist and work as described, §2.3) — **OPEN** for whether Brohda itself needs any provider-side account/registration beyond the Builder program (§2.2's unresolved KYB question) |
| 5 | Builder integration model | **PROVIDER CONFIRMED** — the mechanism, registration flow, and rate caps are documented (§2.2); **OPEN** whether Brohda has actually registered (not done by this milestone, and doing so is a real-world account-creation action outside this milestone's scope per the hard-stop rule) |
| 6 | Builder fee model | **PROVIDER CONFIRMED** for the *cap* (0–100 bps taker / 0–50 bps maker, §2.2); **FOUNDER DECISION** (not made here) for the *actual rate* Brohda would set within that cap |
| 7 | Fee disclosure model | **LOCKED** (architecturally) — total estimated cost must be shown before confirmation (§13/§22); the exact UI is Milestone 5/6's to build |
| 8 | Geography enforcement model | **OPEN** — conceptual pipeline defined (§14), no implementation, no vendor selected |
| 9 | Eligibility inputs | **OPEN** — candidate signals listed (§14), none selected/required yet |
| 10 | KYC/AML responsibility | **COUNSEL REQUIRED** (§5 #7) |
| 11 | Sanctions responsibility | **COUNSEL REQUIRED** (§5 #8) |
| 12 | Age requirement responsibility | **COUNSEL REQUIRED** (§5 #6) |
| 13 | Order idempotency model | **LOCKED** (architecturally) — contract defined (§17), reusing this codebase's own proven idempotency pattern as a template |
| 14 | Reconciliation model | **LOCKED** (architecturally) — source-of-truth hierarchy and scenario handling defined (§18) |
| 15 | Provider outage behavior | **LOCKED** (architecturally) — circuit-breaker principle defined (§23) |
| 16 | Secrets/key-management model | **LOCKED** (architecturally) — storage/access/rotation principles defined (§20), reusing this codebase's existing secrets discipline |
| 17 | Rollout model | **LOCKED** (architecturally) — dimensions defined (§16), reusing `platform_settings`' proven pattern |
| 18 | Kill-switch model | **LOCKED** (architecturally) — scopes defined (§15), reusing `platform_settings`' proven pattern |
| 19 | Balance/funding model | **LOCKED** (architecturally, for the "legacy vs. future are separate" question, §25) — **OPEN** for the legacy-balance migration path itself (inherited directly from the roadmap's own OPEN #5) |
| 20 | Relationship to legacy Brohda wallet | **LOCKED** — explicitly analyzed and separated (§25/§26); no merge, no shared state |
| 21 | Source-of-truth model | **LOCKED** — provider is authoritative, Brohda records are a reconciled mirror (§18) |
| 22 | Audit/logging requirements | **LOCKED** (architecturally) — event list and exclusions defined (§21) |

**Nothing above is marked `LOCKED` in the sense of "implemented" or "legally cleared."** `LOCKED` here means *architecturally decided and internally consistent enough for Milestone 5/6 to build against*, exactly the distinction this document draws throughout between technical design and legal/founder authority.

---

## 30. Milestone 5 prerequisites

Milestone 5 (Simulated Execution) may proceed with:
- **No real signing** — a simulated quote/preview needs no wallet at all.
- **No real wallet** — nothing in §8's wallet model needs to exist for a simulation.
- **No real provider order placement** — Milestone 5's own roadmap scope already says this explicitly ("stopping short of calling the provider's order-submission API").
- **Read-only quote/order-book access** — reusing Milestone 1's already-proven read-only Gamma pattern; the CLOB's own read-only order-book endpoints (not yet used anywhere in this codebase) would be the natural extension if real-time depth is wanted, but even a Gamma-sourced price is sufficient for a first simulation.
- **Hypothetical fee configuration** — §13's fee model is fully definable in configuration terms without a real Builder registration existing yet (a placeholder/example rate is fine for simulation, clearly labeled as simulated, never presented as a real fee).
- **Simulated eligibility** — §14's pipeline can be stubbed/always-true for simulation without resolving any real geofencing/KYC decision.
- **Simulated quote expiry** — §12's `expiresAt` concept can be exercised with an arbitrary configured window, no provider dependency required.

**Mandatory before Milestone 5 (already satisfied by this document)**: the Prediction/Order/Position separation (§11) must be understood and respected by whoever implements the simulation, so the simulation "teaches the product the right domain model" rather than accidentally training a future implementer to conflate a simulated Order with a Prediction. **This is the one genuine risk this task's own instructions flag for Milestone 5** ("the simulation architecture still must not teach the product the wrong domain model") — mitigated by this document existing and by Milestone 3's own already-proven discipline being directly referenced here.

**Not mandatory before Milestone 5**: every `BLOCKED`/`COUNSEL REQUIRED`/`OPEN` item in the Decision Register above — none of them gate a simulation that moves no real money and creates no real financial exposure.

## Milestone 5 status: **READY**

---

## 31. Milestone 6 hard prerequisites — ALL must be resolved before real execution

1. Founder-approved custody model (Decision Register #1) — currently `BLOCKED`.
2. Founder-approved signing model (#3) — currently `BLOCKED`.
3. Legal/compliance sign-off on the product's regulatory classification and Brohda's role (§5 #1, #12) — currently `COUNSEL REQUIRED`, unresolved.
4. Geographic eligibility model approved, including confirmation of which jurisdictions Brohda may legally operate in (§5 #17, #18; Decision Register #8) — currently `OPEN`/`COUNSEL REQUIRED`.
5. Provider integration (Builder registration) actually confirmed/completed with Polymarket (Decision Register #4, #5) — currently `OPEN`, not performed by this milestone.
6. Fee model approved — both the technical cap (confirmed, §2.2) and the founder-chosen actual rate (not yet chosen) and Brohda-fee-if-any (not yet decided) — Decision Register #6.
7. Fee disclosure UX approved and built (§7 of Decision Register is architecturally locked; the actual UI does not exist).
8. Secrets architecture implemented and reviewed (§20 is architecture only; no implementation exists).
9. Reconciliation architecture implemented and tested (§18 is architecture only).
10. Kill switch implemented and tested (§15 is architecture only).
11. Cohort rollout implemented (§16 is architecture only).
12. Execution-specific rate limiting implemented, fail-closed (§24 — decision made, nothing implemented).
13. Audit logging implemented for every event in §21's list.
14. Idempotency implemented per §17's contract.
15. Provider outage / circuit-breaker behavior implemented per §23.
16. A dedicated security review of the actually-implemented signing/secrets code (not just this document) — this document's own threat model (`docs/security/execution-threat-model.md`) is a starting point, not a substitute for reviewing real code once it exists.
17. Appropriate automated tests for every item above, at the same rigor already established for Milestones 1–3 (unit, integration against local Supabase only, E2E) — none exist yet, since none of the above is implemented.

**None of the above is implemented by this milestone.** This document intentionally stops at architecture, per its own scope and the task's explicit hard-stop rule.

## Milestone 6 status: **BLOCKED**

---

## 32. Code/prototypes created this milestone

**None.** No safe non-financial prototype was judged necessary — every architecture question in this document was resolvable through documentation research and internal design reasoning alone, without needing to construct even a disposable signature payload or a read-only network probe. Per this task's own instruction ("if no prototype is necessary, do not create one"), none was built.

---

## 33. Standing hard-coding audit (execution-specific)

| Item | Classification |
|---|---|
| The `ExecutionProvider`/`Quote`/`Order`/etc. conceptual contract shapes themselves (§10) | True invariant (architectural) — same reasoning as `PredictionMarketProvider`'s own closed interface |
| Prediction/Order/Position structural separation (§11) | True invariant (architectural) |
| Source-of-truth hierarchy (provider authoritative, §18) | True invariant (architectural — this is a correctness property, not a tunable) |
| Fail-closed execution rate limiting (§24) | True invariant, once real execution exists — the *decision to fail closed* is not reconsidered per-deployment; the numeric rate values within that policy are configurable |
| Allowed/blocked jurisdictions | Legal/compliance policy AND configurable operational policy once legally bounded — never hard-coded (§14) |
| Fee rates (provider, builder, Brohda) | Configurable product policy / provider-derived value — never hard-coded (§13) |
| Order-size limits, daily exposure limits | Configurable product policy (§16) |
| Quote expiry / stale-quote threshold | Configurable operational policy (§12, §23) |
| Slippage tolerance | Configurable operational policy (§12) |
| Rollout cohort definitions | Configurable product policy (§16) |
| Wallet/provider selection (which provider is active) | Configurable operational policy, reusing the existing `PREDICTION_MARKETS_POLYMARKET_ENABLED`-style environment-gate pattern already proven in Milestone 1 |
| Retry counts / timeout values | Configurable operational policy (§17/§18) |
| Notification behavior for execution events | Configurable operational policy, reusing Milestone 3's own just-built `platform_settings`-driven notification-policy pattern (enablement + per-result triggers + copy templates) as the direct template |
| Reconciliation cadence (polling interval) | Configurable operational policy (§18) |
| Kill switches (all scopes) | Configurable operational policy by definition (§15) |
| Provider enablement flags | Configurable operational policy (§10, mirroring Milestone 1's provider-registry pattern) |
| Compliance toggles (geofencing on/off, KYC required or not) | Legal/compliance policy — configurable, but the *values* are not engineering's to set unilaterally |

**Hard-coded mutable execution policy remaining: NONE.** No numeric fee, geography list, limit, threshold, or toggle was chosen or embedded in code by this milestone, because no execution code was written at all — every value above is documented as a future configuration point, not implemented in either form.

---

## 34. Known limitations of this research

- The Polymarket collateral-asset discrepancy ("pUSD" vs. the more commonly known "USDC") is flagged, not resolved (§1) — requires independent live-API verification before Milestone 5/6 relies on either name.
- The full list of Polymarket-blocked jurisdictions beyond the United States was not independently confirmed — only a landing-page ToS excerpt was fetchable via this milestone's research tooling (§2.4).
- Whether Polymarket's CLOB supports client-supplied idempotent order IDs (relevant to §17's retry-safety design) was not confirmed this milestone — flagged as an open technical verification item for Milestone 6.
- Whether becoming a registered Builder requires Brohda-entity-level KYB, distinct from the described technical registration flow, was not confirmed (§2.2).
- General (non-Relayer) CLOB/Gamma API rate limits were not found with exact figures in the pages fetched this milestone (only Relayer daily-transaction tier caps were).
- As with every prior milestone in this transformation, this development environment's browser-preview tooling remains anchored to an unrelated project directory — not relevant to this milestone specifically, since no UI was built, but noted for consistency with prior milestones' own disclosed limitations.

## 35. Roadmap conflicts

None identified. This document's recommendations and BLOCKED items are consistent with the roadmap's own explicit framing of Milestone 4 as a hard, non-bypassable gate, its own OPEN Decision Register items (§9 there), and its own instruction that "no real-money implementation begins before custody/signing is resolved" (roadmap §11 item 4).
