# Commercial payments (sponsorship) — provider-neutral, ONVO in TEST

**ONVO is for sponsorship payments ONLY** — a Sponsor paying Brohda for advertising media on a Game Post. **ONVO IS NOT THE PLAYER MONEY PROVIDER.** It is never used for Picks, P2P stakes, wallets, deposits, withdrawals, prizes, sponsor-run promotion prizes, or payments between users, and nothing here touches `monetary_p2p_enabled`. No marketplace / split payment / connected account / payout is used: the Sponsor pays Brohda for Brohda's own service.

## The invariant is unchanged

`paid` AND `approved by Super Admin` AND `sponsorship_enabled` AND `in window` AND `not suspended/cancelled` = eligible to run. A provider can satisfy **only the payment half** and can **never** approve anything. Payment success never means LIVE: it sets `payment_status = PAID`, and the *existing* shared settle function moves the sponsorship onto the clock only if an approval already stands and is intact (exactly what the manual path always did). Both orders work (pay → approve, approve → pay).

## Why ONVO / why hosted Checkout

Brohda is Costa Rican-oriented; ONVO supports CRC and USD, SINPE Móvil and cards, and is the provider the owner is being approved with. **Hosted Checkout (one-time link)** was chosen over the Web SDK/custom card handling because it keeps Brohda entirely out of card data (no card number ever reaches Brohda's servers or database), needs the least surface (create a session, send the Sponsor to its URL, receive the result by webhook), and ONVO documents it as the fast path to production. The payment-method choice (card, SINPE, …) is made on ONVO's page; Brohda assumes none.

## ONVO resources used (from ONVO's current docs, docs.onvopay.com + openapi.yaml)

| Purpose | Call |
|---|---|
| Auth | `Authorization: Bearer <secret key>` on `https://api.onvopay.com` (HTTPS only). Test keys `onvo_test_secret_key_…`, live keys `onvo_live_secret_key_…`; the key prefix selects the mode. |
| Start a payment | `POST /v1/checkout/sessions/one-time-link` with `lineItems:[{quantity:1, unitAmount, currency, description}]`, `redirectUrl`, `cancelUrl`, `customerEmail`, `captureMethod:"automatic"`, `metadata` → `{ id, url, … }` |
| Read a session | `GET /v1/checkout/sessions/{id}` → `status` (open/complete/expired), `paymentStatus` (unpaid/paid), `paymentIntentId`, `mode` |
| Read the money | `GET /v1/payment-intents/{id}` → `status`, `amount`, `currency`, `mode` |
| Refund | `POST /v1/refunds` `{ paymentIntentId, amount, reason, description }`; `GET /v1/refunds/{id}` → `pending`/`succeeded`/`failed` |
| Webhooks | `POST` to our endpoint with header `X-Webhook-Secret` and `{ type, data }`; events used: `checkout-session.succeeded`, `payment-intent.succeeded`, `payment-intent.failed`, `payment-intent.deferred`. `mobile-transfer.received` and `subscription.*` are acknowledged and ignored (the former "does not confirm a payment by itself"). |

Amounts are integers in the currency's minor unit (USD cents; CRC céntimos) — one conversion helper, `lib/payments/amount.ts`. Supported currencies are ONVO's list; an unsupported one is refused before any request.

## Layers (nothing ONVO leaks past the adapter)

* **Domain / database (provider-neutral):** `commercial_payment_attempts` (provider, environment TEST/LIVE, local status, frozen amount/currency, provider session & payment reference, timestamps), `commercial_payment_provider_events` (idempotency ledger + operational audit; no raw payload), `commercial_payment_refunds`; functions `commercial_payment_begin / _claim_creation / _attach / _creation_failed / _apply_result`, `commercial_refund_begin / _record`, and `sponsorship_settle_payment` (the one place a sponsorship becomes PAID; the manual `admin_mark_sponsorship_paid` now calls it too). Migration `189`.
* **Service (`lib/payments/service.ts`):** orders the steps; provider-neutral.
* **Adapter (`lib/payments/onvo/*`):** the only ONVO vocabulary: HTTP client, webhook parser, mapping to Brohda's words (`PENDING/FAILED/EXPIRED/SUCCEEDED`).
* **Config (`lib/payments/config.ts`):** env-driven and fail-closed.
* **Core sponsorship code** (`lib/sponsorship`, eligibility, approval, scheduling, public rendering) contains no provider logic (a test enforces it).

## Flow

1. Sponsor clicks **Pay with ONVO** (only offered for a submitted, unpaid sponsorship of an ACTIVE Sponsor, capability ON, ONVO configured and offered). The form carries a sponsorship id and a de-duplication key — **never an amount.**
2. `commercial_payment_begin` (database): checks ownership, ACTIVE Sponsor, capability, `SUBMITTED`, payable status, and **reads the frozen price/currency**. One open attempt per sponsorship (partial unique index + row lock): a double-click or second tab returns the same attempt. An open attempt that no longer matches is superseded.
3. Exactly one request wins `commercial_payment_claim_creation` and creates the ONVO session (others wait for its URL); the session carries our attempt id in `metadata`; the Sponsor is redirected to ONVO's hosted page. Return URLs are fixed server-side paths — a visitor cannot supply one.
4. **Return page is NOT proof.** It shows Brohda's own record; if an attempt is still open it asks the provider server-side (the same trusted path as reconciliation). Visiting, refreshing or forging the URL changes nothing.
5. **Trusted confirmation:** the webhook (secret verified in constant time *before* the body is read) → for a success, Brohda **re-reads the provider** (session → payment intent) and uses the *provider's* amount/currency → `commercial_payment_apply_result`.

## Local status mapping and the ordering strategy

| Provider | Local attempt | Sponsorship `payment_status` |
|---|---|---|
| open / processing / deferred | `PENDING` | `PENDING` (never PAID) |
| declined / failed | `FAILED` (retryable) | `FAILED` |
| session expired | `EXPIRED` | stays `PENDING`; next click makes a new attempt |
| succeeded, amount+currency = frozen price | `SUCCEEDED` | `PAID` |
| succeeded, wrong amount/currency | `MISMATCH` | unchanged — flagged for review |
| succeeded but already paid by another route | `DUPLICATE_PAYMENT` | unchanged — flagged, **never auto-refunded** |
| succeeded but the sponsorship can't take it (e.g. cancelled) | `UNAPPLIED` | unchanged — flagged |

Raw provider status is kept on the attempt for reconciliation. **Idempotency:** ONVO sends no event id, so each fact gets a deterministic key from what it states (`type + object id + outcome`); the ledger insert is the check and happens in the same transaction as the state change, so a failure rolls both back and a retry reprocesses. **Out of order:** states are monotonic — `SUCCEEDED` is terminal and wins whenever it arrives (failed→succeeded ends PAID); a late `FAILED`/`PENDING` after `SUCCEEDED` is recorded as stale and ignored. An unknown provider object is acknowledged (200) and recorded as `UNKNOWN_OBJECT`; a TEST event can never settle LIVE.

## Double payment & the manual fallback

* Manual payment (Super Admin marks received, with a reference) is unchanged and always available; a sponsorship uses MANUAL **or** ONVO for a given obligation. Marking it paid manually **closes any open ONVO attempt**; a later ONVO success is flagged `DUPLICATE_PAYMENT` for a human decision.
* One open attempt and at most one `SUCCEEDED` attempt per sponsorship are database constraints, not conventions.

## Refunds

Brohda's refund **policy** (docs/architecture/sponsor-identity.md, "Refund policy V1") decides **whether** a refund is owed; ONVO is only one **method**. Super Admin can "Refund through the provider" for an ONVO-paid sponsorship: the full amount via `POST /v1/refunds`. **Nothing becomes `REFUNDED` until the provider confirms** (`succeeded`); `pending` is recorded as `REFUND_PENDING` and re-checked with "Check refund" (ONVO documents no refund webhook). A refusal, or an unknown outcome (network), marks nothing refunded and leaves the **manual refund** as the fallback (ONVO's refund terms/windows are not assumed). One non-failed refund per payment (duplicates refused). Partial refunds are not built (the product doesn't need them). Suspension, cancellation and Sponsor suspension never refund.

## Reconciliation

Super Admin → sponsorship → **Reconcile with provider** reads the provider's own record for an attempt and applies it through the same idempotent path (so a missed webhook is fixed, a repeat is a no-op, a correction is audited). A provider outage during reconciliation changes nothing. Unknown outcomes are never guessed: a creation timeout leaves a `FAILED`/retryable attempt (any session that did get created and is later paid is still matched through its `metadata` attempt id).

## Provider configuration (r66) — which provider takes payments is operational configuration

**Policy vs secrets.** Two things decide whether a Sponsor can pay online, and they live in different places on purpose:

| | Where | Who changes it | Needs a deploy? |
|---|---|---|---|
| **Policy** — online payments on/off, and *which* installed provider takes NEW payments | `platform_settings.sponsorship_online_payments_enabled`, `sponsorship_online_payment_provider` (no secrets) | Super Admin, Admin → Sponsorship → *Online sponsorship payments* (audited `settings.online_payments_updated`: previous/new provider, enabled, actor, time) | **No** |
| **Secrets / runtime configuration** — API keys, webhook secret, TEST/LIVE mode | Hosting environment variables (e.g. the `ONVO_*` names) | Operator, in the host | Needs an env change + redeploy/restart |

Online payment is offered only when **both** say yes: the policy selects a provider **and** that provider's adapter is installed, can take checkout payments, and reports its own configuration valid. If the setting names a provider that is not installed, has missing/inconsistent credentials, or is an unknown key, online payment is **unavailable** — it never silently falls back to another provider. Manual payment is independent and always available.

**Propagation.** The two settings are read from the database on every request (no cache). A Super Admin change applies to the *next* Sponsor page load / payment start, immediately, with no deploy and no migration. Secret changes follow the host's own environment-variable rollout.

**Registry.** `lib/payments/registry.ts` is the one place that lists installed adapters. A provider key is only ever *looked up* there — never executed from data. Adding a provider = write its adapter (`lib/payments/<provider>/`) and add one line to the registry; choosing it, switching, enabling and disabling are then configuration. There is no runtime code loading or plugin system. Tests install a fake second adapter (`TEST_PROVIDER`) through `registerTestAdapter`, which only works when `NODE_ENV === "test"`.

**Capabilities.** Each adapter declares `supportsCheckout / Refund / PartialRefund / Reconciliation / RefundWebhook`. Core code asks these; it never asks "is it ONVO". A provider without a capability simply isn't offered that action (Super Admin falls back to the manual path).

**Database.** `commercial_payment_attempts.provider` accepts any well-formed key (`^[A-Z][A-Z0-9_]{1,39}$`); which keys are *usable* is decided by the application registry, not a CHECK. An unknown key in the database fails closed.

**Historical attempts belong to the provider that processed them.** Every attempt snapshots its provider. Reconcile, refund, refund-check and webhooks always go through the attempt's *original* adapter, whatever is currently selected (or even if online payments are disabled). A provider that is no longer installed cannot be reconciled/refunded — the UI says so and the manual path remains.

**Switching with an open attempt.** An open (CREATED/PENDING) attempt of provider A is never converted to provider B. When a Sponsor starts a payment under B, the service first asks A (through A's adapter) where the attempt stands; if it has ended (failed/expired/paid) it is recorded and B proceeds; if it is still open the Sponsor is told their earlier payment is in progress. Super Admin can also cancel the open attempt explicitly (*Cancel this open payment*, audited as `sponsorship.payment_attempt_cancelled`). A cancelled attempt stays on record and a late provider success is still recognised (duplicate-payment handling applies).

**Disabling** stops only NEW attempts. Webhooks (`/api/webhooks/<provider>` dispatch through the neutral service by provider key, independent of the setting), reconciliation and refunds of existing attempts keep working.

**Sponsor-facing copy is provider-free** ("Pay now", "complete the payment on a secure page"). The Super Admin card shows the provider's registered label as data. The provider-named webhook route is infrastructure.

### Hard-coding audit (every `ONVO`/`onvo` occurrence, classified)

| Where | Classification |
|---|---|
| `lib/payments/onvo/*` (adapter, client, config, webhook) | **Allowed** — the ONVO adapter |
| `lib/payments/registry.ts` (`ONVO: () => new OnvoProvider()`) | **Allowed** — the one installation line |
| `app/api/webhooks/onvo/route.ts` | **Allowed** — provider-specific URL, passes its key to the neutral `handleProviderWebhook` |
| `scripts/onvo-test-proof.ts`, `package.json` `onvo:test-proof` | **Allowed** — ONVO-specific operator tool |
| `.env.example`, `docs/*`, `playwright.config.ts` env | **Allowed** — env var names (secrets) and internal docs/test wiring |
| `tests/**` ONVO adapter/sandbox tests, `tests/helpers/onvo-sandbox.ts` | **Allowed** — adapter tests |
| `supabase/migrations/…189` (`check (provider in ('ONVO'))`) | **Historical** — applied migrations are never rewritten; **removed by migration `190`** (replaced by a format check) |
| `lib/payments/service.ts`, `types.ts`, `config.ts`, `active-provider.ts`, `views.ts` | **Clean** — no provider names (asserted by `tests/unit/provider-neutral-copy.test.ts`) |
| Sponsor UI, Super Admin card, emails, notifications, legal | **Clean** — asserted by the same test |
| `…NotifyOnVoid`, `createPositionVoidedNotifications` | Not payments (the substring "onvo" inside "NotifyOnVoid") |

Forbidden patterns now absent: a provider CHECK constraint, `if (provider === "ONVO")` in core, a hard-coded active provider, a "Pay with ONVO" button, provider branding to Sponsors.

## Environments and safety

`ONVO_SECRET_KEY`, `ONVO_WEBHOOK_SECRET`, `ONVO_ENVIRONMENT` (TEST|LIVE, must agree with the key prefix) are required or ONVO is **unavailable** (fail closed). A live key does **not** enable live payments: `ONVO_LIVE_ENABLED=true` is a separate, deliberate operational flag. TEST checkout is **hidden from Sponsors on the production deployment** unless `PAYMENTS_ALLOW_TEST_IN_PRODUCTION=true`. Secrets are server-side only (never in props, responses, logs, commits). Attempts carry their environment; Super Admin sees a **TEST** badge and "no real money moved — do not count as revenue". No card data, bank data, secrets or raw payloads are stored.

## Operator checklist — TEST (owner)

1. ONVO Dashboard (test mode) → copy the **test secret key** (`onvo_test_secret_key_…`) and the **webhook secret** (`webhook_secret_…`).
2. Dashboard → Developers → Webhooks → add `https://<host>/api/webhooks/onvo` (production host: `https://brohda.com/api/webhooks/onvo`); enable `checkout-session.succeeded`, `payment-intent.succeeded`, `payment-intent.failed`, `payment-intent.deferred`.
3. Set in Vercel (Preview or a staging project first): `ONVO_SECRET_KEY`, `ONVO_WEBHOOK_SECRET`, `ONVO_ENVIRONMENT=TEST`. Do **not** set `PAYMENTS_ALLOW_TEST_IN_PRODUCTION` on production unless you intend real Sponsors to see a test checkout.
4. Test with ONVO's published test card `4242 4242 4242 4242` (decline `4000 0000 0000 0002`, 3DS `4000 0000 0000 3220`); SINPE test numbers are in ONVO's Testing page. Run `pnpm onvo:test-proof` for the credentialed API proof.
5. Check Admin → Sponsorship → "Online payments": Environment TEST, Webhook secret configured, Live payments disabled.

*Webhook configured / dashboard set up:* **not done and not claimed** — it needs the owner's ONVO account.

## Future live cutover (owner-authorized, separate operation — NOT done)

ONVO approves Brohda → obtain live keys → configure the **live** webhook (`https://brohda.com/api/webhooks/onvo`) and any allowed domains → set `ONVO_SECRET_KEY` (live), `ONVO_WEBHOOK_SECRET` (live), `ONVO_ENVIRONMENT=LIVE`, and only then `ONVO_LIVE_ENABLED=true` → verify merchant identity → run the lowest-risk approved live payment → verify the webhook, the PAID state, the refund → the Sponsor-facing option appears (manual fallback stays) → counsel review of the Sponsor Privacy section for the payment processor and transaction identifiers.

## Not built (by design)

Saved cards / customers (one-time payments only; a Sponsor is not mapped to an ONVO customer), partial refunds, subscriptions, marketplace/split/connected accounts, payouts, any use for prizes or player money, settlement tracking (a successful payment is enough for eligibility; bank settlement is accounting metadata).
