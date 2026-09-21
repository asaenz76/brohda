# Milestone 6 Provider Readiness Checklist

> **DEPRECATED (2026-09-21).** This document describes the abandoned Polymarket / real-money-execution product direction. It is historical only — see `docs/deprecated/polymarket-execution-direction-2026/README.md` and `docs/architecture/sports-prediction-network.md` for Brohda's current, sports-only direction. Nothing below reflects the active product.


**Status**: A checklist for Polymarket-side readiness. **No item below is marked complete without evidence** — an evidence column is mandatory for every row, and "not yet started" is the honest default. No account was created, no registration was submitted, and no credential was issued by the task that produced this document — see [`docs/architecture/milestone-6-readiness.md`](./milestone-6-readiness.md) §3/§5 for the full research this checklist is built from.

---

| # | Item | Status | Evidence required to mark complete | Current evidence |
|---|---|---|---|---|
| 1 | Builder registration complete | Not started | A Builder profile exists under a Brohda-controlled Polymarket account, with a copyable builder code visible in Settings → Builders | None |
| 2 | Account approved | Not started (Unverified tier requires no approval, per provider docs re-verified 2026-09-16 — see readiness doc §3) | Confirmation that the account is in the intended tier (Unverified is sufficient to start; Verified/Partner require the email-based approval process documented in readiness doc §3) | None |
| 3 | Required KYB complete | **Unknown whether required at all** | Either (a) a confirmation from Polymarket that no KYB step exists for the Builder program, or (b) completion of whatever KYB step the actual registration flow presents | None — this is the single largest unresolved provider-fact gap after two research passes (Milestone 4 and this readiness task); classified `PROVIDER CONFIRMATION REQUIRED` in the readiness doc's decision matrix (§6) |
| 4 | Credentials issued | Not started | A builder code (and, if the actual flow issues one, any additional credential/API key) recorded in Brohda's chosen secrets architecture (readiness doc §15) | None |
| 5 | Builder code available | Not started | The `builder` bytes32 value confirmed working in a controlled test order once legally/technically authorized to place one (not authorized by this document) | None |
| 6 | Fee configuration confirmed | Not started | The founder's chosen taker/maker rate (within the provider-confirmed cap of 0–100/0–50 bps) set on the Builder profile, with a screenshot or API confirmation of the configured value | None — founder rate not yet chosen (readiness doc §16, founder-decisions.md) |
| 7 | Session Key mechanism verified | Not started | A successful Session Key creation/authorization/revocation cycle observed against a real (non-financially-exposed, or minimally-exposed and pre-authorized) Deposit Wallet, once legally authorized | None |
| 8 | Rate limits confirmed | **Documented, not independently load-tested** | The published limits (readiness doc §3: general REST 15,000/10s, CLOB general 9,000/10s, single-order POST/DELETE 5,000/10s burst / 120,000/10min sustained, batch endpoints lower) re-verified against the live `docs.polymarket.com/api-reference/rate-limits` page immediately before implementation, since this page can change without notice | Fetched 2026-09-16 from `docs.polymarket.com/api-reference/rate-limits`; not independently load-tested |
| 9 | Funding/collateral confirmed | **Resolved** | pUSD (ERC-20, Polygon, 6 decimals, 1:1 USDC-backed) confirmed as the settlement/collateral asset; USDC/USDC.e remains the deposit-facing asset, auto-wrapped into pUSD (readiness doc §4) | Fetched 2026-09-16 from `docs.polymarket.com/concepts/pusd`, `docs.polymarket.com/concepts/positions-tokens`, and `help.polymarket.com`'s April 28, 2026 exchange-upgrade article |
| 10 | Order placement docs re-verified | **Re-verified this task** | Order struct fields confirmed current (`salt`, `maker`, `signer`, `tokenId`, `makerAmount`, `takerAmount`, `side`, `signatureType`, `timestamp`, `metadata`, `builder`, `expiration`); `tick_size`/`min_order_size` confirmed to be read live per market, not fixed constants, and `tick_size` confirmed capable of changing mid-session via a `tick_size_change` stream event | Fetched 2026-09-16 from `docs.polymarket.com/developers/CLOB/orders/create-order` |
| 11 | Cancellation docs re-verified | **Re-verified this task** | Cancellation confirmed possible "at any time before matched," except during a pending delay window; partial fills confirmed to leave only the unfilled remainder cancellable | Fetched 2026-09-16 from `docs.polymarket.com/concepts/order-lifecycle` |
| 12 | Position/fill APIs confirmed | **Partially re-verified** | Trade-status lifecycle confirmed (`MATCHED`→`MINED`→`CONFIRMED`/`RETRYING`→`FAILED`); a dedicated, comprehensive fills/positions API distinct from order-status lookups was **not independently re-fetched this task** — carried forward as the same gap Milestone 4 identified | Fetched 2026-09-16 (order-lifecycle page only) |
| 13 | Geography restrictions confirmed | **Confirmed, first-party, dated — a material improvement over Milestone 4's finding** | A named list of 39 blocked countries (including the United States) plus specific blocked Canadian provinces and Ukrainian regions, and a separate close-only list (Poland, Singapore, Taiwan, Thailand), obtained directly from Polymarket's own Help Center | Fetched 2026-09-16 from `help.polymarket.com/en/articles/13364163-geographic-restrictions` — **this is a live, operator-maintained page that changes over time; re-fetch immediately before Milestone 6 launch, do not rely on this document's cached list** |

---

## Additional open items surfaced by this task's research (not on the original 13-item list, but material)

| Item | Finding | Status |
|---|---|---|
| Client-idempotent order IDs | No client-supplied idempotency-key field found on the order-creation endpoint; the API returns a server-generated `orderId` | `PROVIDER CONFIRMATION REQUIRED` — directly affects the idempotency/reconciliation adapter design (readiness doc §21) |
| Builder fee change cadence | A builder may change its configured fee rate at most once per 7 days, with 3-day advance notice, and cannot have multiple pending changes | `PROVIDER CONFIRMED` — an operational constraint for any future fee-change runbook |
| Deposit Wallet default cutover date | May 4, 2026 (all new accounts) | `PROVIDER CONFIRMED` |
| Deposit Wallet beacon-proxy upgrade | June 29, 2026 — implementation upgrades pushed without changing wallet address; opt-out available (forfeits future upgrades) | `PROVIDER CONFIRMED` |
| pUSD migration date | April 28, 2026 exchange upgrade — trading paused ~1 hour; v1 client libraries stopped working against the new (V2) contracts | `PROVIDER CONFIRMED` |
| Withdrawal/redemption mechanics | `POST /withdraw` + status polling; pUSD unwrapped to USDC via a "Collateral Offramp" and a Uniswap v3 pool | **Lower confidence — found via `WebSearch` summary, not independently re-fetched with `WebFetch` this task.** Flagged `PROVIDER CONFIRMATION REQUIRED` before any withdrawal-adjacent code is written, even though Brohda's recommended architecture never intermediates withdrawal |

---

## Summary

**Do not mark any row above complete without the evidence column being genuinely filled in.** As of this document, every row is either "not started" or "documented but not yet independently load-tested/operationally exercised" — no row reflects a completed real-world provider action, consistent with this task's explicit prohibition on creating accounts, submitting registrations, or performing any provider mutation.
