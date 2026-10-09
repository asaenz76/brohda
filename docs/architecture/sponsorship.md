# Sponsorship foundation (Milestone 1) — architecture decision record

Status: implemented in migration `20260101000181_sponsorship_foundation.sql`. Operations: `docs/OPERATIONS_RUNBOOK.md` → "Sponsored Game Posts".

## The twelve decisions

1. **Sponsorship is media inventory layered on canonical Game Posts.** A sponsor buys presentation *around* a Post. It adds a row beside the Post (`sponsorships` → `posts`); it never copies, replaces or alters the Post, Game, Markets, Picks, comments or Call BS. Integration tests assert the Post/Game/Market rows are unchanged by every sponsorship transition.
2. **Sponsors never own or create Game Posts.** There is no sponsor path to create a Game, Post or Market, to change a line or a grade, or to touch comments. Sponsors reference an *existing* `posts` row, only through inventory that Super Admin created.
3. **PAID + SUPER ADMIN APPROVED is required for LIVE.** Enforced by a `CHECK` constraint on `sponsorships` (`lifecycle in (SCHEDULED, LIVE)` ⇒ `payment_status = PAID` ∧ `review_status = APPROVED` ∧ an approval hash ∧ an approver) and by the single public-eligibility policy. Payment alone never publishes; approval alone never publishes; either order works.
4. **A sponsor cannot self-publish or self-activate.** The sponsor-facing functions are create / edit / submit / cancel only. Approve, reject, price, mark-paid, suspend and inventory functions each check `is_super_admin(actor)` themselves (an `admin`-role user is refused). There is no webhook, payment or schedule path that approves.
5. **`sponsorship_enabled` is the one feature switch**, a `platform_settings` column edited in the existing Super Admin settings (domain "Sponsorship"), audited atomically by the settings RPC. Default OFF. Fail-closed: only a successfully read literal `true` is ON (`lib/sponsorship/capability.ts`; every sponsor function and RLS policy applies the same rule through `sponsorship_capability_on()`).
6. **Sponsorship is separate from monetary P2P.** No shared tables, no wallet, ledger, Position, fee or stake. Commercial payments are provider-neutral `sponsorship_payment_events` (append-only, MANUAL today). `monetary_p2p_enabled` is neither read nor written.
7. **Sponsor promotions are external, sponsor-run metadata only**: title, description, prize description, official-rules link, who runs it, eligibility summary, dates. They render only inside an approved, active sponsorship.
8. **Brohda does not run prize draws, qualification or fulfillment.** No entries, qualification, draws, winners, prize custody, prize payout or promotion settlement exist in the schema (asserted by a catalogue test). Members only see a link to the sponsor's official rules and a disclosure that the sponsor — not Brohda — runs it.
9. **Sponsor-facing user data is not exposed.** Sponsors see only their own sponsorships, status, price and payment state. No member, Pick, location, wallet or behavior data is reachable; impressions/clicks are internal and not exposed to sponsors in this milestone.
10. **Sponsor Intelligence is a later, aggregate-only layer.** This milestone only records the raw hooks it will need (below). `sponsor_intelligence_enabled` is reserved, not built.
11. **One active sponsor per Post + market + period in V1.** Inventory is one slot per `(post_id, market_code)` with one window; a partial unique index lets at most one sponsorship hold a slot (`SUBMITTED`, `SCHEDULED`, `LIVE`, `SUSPENDED`). Two sponsors racing for it: exactly one wins.
12. **Super Admin owns final pricing.** Price lives on inventory and is snapshotted onto the sponsorship at submission; Super Admin may reprice before payment; once PAID the snapshot is immutable (trigger) and later inventory edits never touch it. Sponsors never set a price.

## Data model

| Table | Purpose |
|---|---|
| `sponsors` | the organization (display name, legal name, logo path, contact email, status ACTIVE / SUSPENDED / DISABLED) |
| `sponsor_accounts` | the Sponsor LOGIN ↔ organization link (one-to-one; see `sponsor-identity.md`). Replaced the retired `sponsor_users` member↔organization table |
| `sponsorship_inventory` | which Game Posts are sponsorable, price, currency, market code, campaign window; `unique (post_id, market_code)` |
| `sponsorships` | the proposal/campaign: content, commercial snapshot, and three orthogonal states |
| `sponsorship_payment_events` | append-only payment history, idempotent on `idempotency_key` |
| `sponsorship_approvals` | immutable snapshot of exactly what was approved (content hash + JSON) per revision |
| `sponsorship_exposure_events` | internal impression/click hooks |
| `audit_logs` (existing) | every commercial action, written in the same transaction as the change |

### State model

Three columns, not one enum and not loose booleans:

- `lifecycle`: DRAFT → SUBMITTED → SCHEDULED → LIVE → COMPLETED; SUSPENDED; REJECTED; CANCELLED
- `review_status`: PENDING / APPROVED / REJECTED / CHANGES_REQUESTED
- `payment_status`: UNPAID / PENDING / PAID / FAILED / REFUND_PENDING / REFUNDED / CANCELLED

Transitions (all in security-definer functions that lock the row, re-check actor/ownership/capability/state, audit, and are idempotent):

```
DRAFT --submit--> SUBMITTED (payment PENDING, price snapshotted, inventory held)
SUBMITTED --changes requested--> SUBMITTED/CHANGES_REQUESTED --sponsor edits+resubmits--> SUBMITTED/PENDING (revision+1)
SUBMITTED --reject--> REJECTED                          (payment untouched; refund is a separate explicit step)
SUBMITTED + PAID + APPROVED --> SCHEDULED | LIVE | COMPLETED   (by the clock)
SCHEDULED --clock--> LIVE --clock--> COMPLETED
SCHEDULED|LIVE --suspend--> SUSPENDED --unsuspend--> SCHEDULED|LIVE (only if still paid + approved + unchanged)
any non-terminal --cancel--> CANCELLED;  refund pending/refunded ends the campaign (CANCELLED)
```

Impossible by constraint: `PAYMENT_PENDING → LIVE`, `PAID_PENDING_REVIEW → LIVE`, `REJECTED → LIVE`.

## Approve-then-swap is impossible

A trigger on `sponsorships` voids the approval (review → PENDING, hash/approver cleared, SCHEDULED/LIVE → SUBMITTED) whenever a *material* column changes on an approved row — whichever code path made the change. The material set (`sponsorship_material_hash`) covers sponsor, Post, market, presented-by, tagline, CTA, destination, logo, the whole promotion block, price, currency and window. The public view also compares the stored approval hash to the current content (`approval_intact`), so a tampered row cannot render even if every status column looks right. Sponsors cannot edit after submission at all (only a draft, or a submission sent back for changes).

## One public eligibility policy

`lib/sponsorship/eligibility.ts#isSponsorshipPubliclyActive` is the only place that decides: capability ON (literal `true`), paid, approved and intact, lifecycle SCHEDULED/LIVE, the clock inside the window (a stale stored status is never trusted), sponsor ACTIVE, the viewer's market covered, the Post published and the Game not cancelled/abandoned, an approved destination. Feed cards, Community timelines, the Post page, the click redirect and impression recording all go through it (`lib/sponsorship/public.ts`). With the capability OFF no sponsorship query is even made.

## Geography

Brohda has **no trustworthy per-viewer location** (no country, no IP-derived region; only a self-chosen analytics timezone). Inferring one from unrelated data is out of bounds, so today the only market a viewer can be shown is `GLOBAL` (`lib/sponsorship/geography.ts`, one function). A country-coded sponsorship is stored, reviewed and paid normally but never publicly shown until a reliable signal exists. `market_code` is data, so per-market sponsors for the same Post need no schema change.

## Payments (provider-agnostic, manual in V1)

No commercial payment provider exists in the repository and none was chosen (owner decision). The existing wallet/USDT code is the player P2P domain and was deliberately not reused. V1 flow: sponsor submits → payment `PENDING` → Brohda invoices/collects outside the app (instructions shown to the sponsor come from settings) → Super Admin records "payment received" with a reference (who/when/note audited; idempotent) → approval is still independent. Payment success is never derived from a client claim or a success URL. Refunds are explicit statuses (`REFUND_PENDING`, `REFUNDED`) recorded by Super Admin — never automatic, and moving money back ends the campaign. Only references/statuses are stored: no card data, bank credentials or provider secrets.

## End of campaign (decision)

A campaign ends at its window's `ends_at` (default: configurable hours after kickoff). After that it is `COMPLETED`: the commercial record, snapshot and audit stay, and **the sponsor presentation is removed** from the Post — an old Game never reads as currently sponsored. (A permanent small "Presented by" credit on historical Posts was considered and not built; it can be added later as a read of COMPLETED rows without any schema change.)

## Measurement hooks (for Sponsor Intelligence)

- **Impression**: a *signed-in member's* browser reported the "Sponsored · Presented by" line as ≥ 50% visible for ≥ 1 second; stored once per (sponsorship, member, UTC day) by a unique index. A server render or API fetch is not an impression; anonymous visitors are not recorded.
- **Click**: a request to the first-party `/sponsorship/click/<id>` redirect while the sponsorship is publicly active. The destination is read from the stored, validated record — never from the request — so it cannot be an open redirect. No third-party pixels or cross-site identifiers.
- Both reference `sponsorship_id` and `post_id` (+ the member id, internal only). Nothing is exposed to sponsors. Downstream questions (uniques, Picks, comments, Call BS) join these with existing tables.

## Authorization and exposure

All new tables have RLS on with no write grants; sponsors read their own rows, Super Admin reads all, everyone else reads nothing. All writes go through service-role functions. Public payloads (`PublicSponsorship`) carry only presented-by, tagline, CTA text, logo URL and the approved promotion — never price, payment, review notes, contact, internal name, audit data or the raw destination. Destination URLs are validated twice (zod parse + database check): `http(s)` only, no credentials, no `javascript:`/`data:`. Logos: JPEG/PNG/WebP only (magic-byte checked, SVG refused), size from settings, re-encoded server-side, stored under an unguessable name.

## Deliberately not built

Sponsor Intelligence UI or exports, self-serve ad buying, auctions/bidding, ad networks, personalized ads, sponsor access to individual users, sponsor-created sports content or Markets, sweepstakes/prize engine, sponsor payouts, agency hierarchies, subscription billing, AI creative, MLB/soccer/SEO, any change to monetary P2P, the NBA Spread gate, or sports data.
