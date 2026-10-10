# Sponsor identity: Member XOR Sponsor accounts

## The invariant

A Brohda auth account is **a MEMBER or a SPONSOR — never both, and never convertible**. It is enforced in the database, not in app code:

| Fact | Where |
|---|---|
| `account_types(user_id, account_type)` — server-owned; `MEMBER` or `SPONSOR`; **immutable** | table + `account_types_guard` trigger. Authenticated users can only `select` their own row; no client write path; user metadata is never consulted |
| A MEMBER has a `user_profiles` row | `user_profiles_require_member` (BEFORE INSERT): types the login MEMBER if untyped, **refuses** if it is already a SPONSOR |
| A SPONSOR has a `sponsor_accounts` row (login ↔ organization, one-to-one) and **no** profile | `sponsor_accounts_require_sponsor` (BEFORE INSERT): refuses if a profile exists, types the login SPONSOR, refuses a MEMBER |
| Typing directly can't contradict the rows | `account_types_guard`: SPONSOR refused if a profile exists; MEMBER refused if a sponsor account exists |
| One email, one account | Supabase Auth's global unique email + `account_type_for_email()` (service-role only) used by Member-creating paths and the Sponsor signup |

Because every Member table (Picks, comments, Call BS, monetary proposals, wallet, follows, notifications, reputation) is keyed by a real foreign key to `user_profiles(id)`, **a Sponsor structurally cannot create any social or monetary data** — isolation does not depend on every code path remembering a check. The server-side guards add a second, independent layer.

## Data

* `account_types`, `sponsor_accounts`, `sponsor_terms_acceptances` (versioned acceptance mechanism; no legal text).
* `sponsors` gained `website`, `country`, `contact_name`, `contact_phone`, `status_reason` (shown to the sponsor), `internal_review_note` (Super Admin only), `reviewed_by`, `reviewed_at`; `sponsor_status` is now `PENDING_REVIEW | ACTIVE | REJECTED | SUSPENDED | DISABLED` and the column default is `PENDING_REVIEW` (fail safe).
* `sponsor_users` (the old Member↔organization link, many-to-many) is **dropped**. The migration refuses to run if it still holds any link. Production had zero.
* Columns a Sponsor login writes (`sponsorships.created_by/cancelled_by`, `sponsorship_payment_events.actor_id`) now reference `auth.users`; audit rows for a Sponsor actor use the additive `audit_logs.actor_account_id` (a Sponsor has no profile for `actor_id`).
* Backfill: every existing `user_profiles` row → `MEMBER`. An auth account **without** a profile is *not* classified (it is reported, not guessed).

## Lifecycle

`signup (unverified login) → verification email → first sign-in → PENDING_REVIEW → Super Admin: ACTIVE | REJECTED`, then `ACTIVE ⇄ SUSPENDED`, `* → DISABLED`, `SUSPENDED/DISABLED/REJECTED → ACTIVE (restore)`. One audited database function (`admin_set_sponsor_status`) applies a transition: it re-checks Super Admin (an ordinary admin cannot), validates the move, requires a reason for anything but ACTIVE and is idempotent.

Account status is a **separate gate from per-sponsorship approval**: `ACTIVE` lets a Sponsor browse inventory and start sponsorships; each sponsorship still needs payment and Super Admin approval. A non-ACTIVE Sponsor's sponsorships stop being public immediately (the existing eligibility policy requires `sponsor.status = ACTIVE`).

## Signup (`/sponsor/signup`)

Server action `sponsorSignupAction`: validate → (terms acceptance, once approved text exists) → rate limit (per email and per IP) → neutral exclusivity pre-check → `auth.signUp` with a **stateless anon client** (Supabase sends the verification email; nothing here can mark an email verified) → **fail closed** if a session comes back (confirmation misconfigured: the login is deleted and nothing is created) → `create_sponsor_account` (one transaction: type + organization `PENDING_REVIEW` + link; advisory-locked per login, so retries and races yield exactly one organization) → optional logo → terms acceptance. A failure after the login was created removes a login *this call* created; it never deletes a pre-existing one. All "email taken" outcomes — a Member's email, a confirmed Sponsor's email — return the same neutral message and create nothing.

## Routing and guards

* Proxy (`lib/supabase/middleware.ts` → `lib/auth/account-routing.ts`): a signed-out visitor to `/sponsor/*` goes to `/sponsor/login`; a SPONSOR hitting any Member area (`/feed`, `/wallet`, `/admin`, `/post/…`, …) goes to `/sponsor`; a MEMBER hitting `/sponsor/*` (except the three public entry pages) goes to `/feed`.
* Guards: `requireMemberAccount()` (alias `requireUser()`; positive MEMBER check; a Sponsor is redirected to `/sponsor`), `requireSponsorAccount()` (any status), `requireActiveSponsorAccount()` (commercial access). Server actions call these first; the database RPCs re-check actor, ownership, status and capability.
* One login page works for everyone (`/login` sends a Sponsor to `/sponsor`; `/sponsor/login` sends a Member to `/feed`); Sponsors never see the Member shell (`components/sponsor/SponsorShell.tsx` is separate).

## Policies (documented decisions)

* **Brand identity after approval.** The brand/company name and logo are editable only while `PENDING_REVIEW` (enforced in `sponsor_update_profile` and the logo route). After activation they are locked (they are shown to Members and a materially different business must not slip through an approved account); Super Admin can change them on the sponsor's card. Contact name, website, country and phone remain editable while `PENDING_REVIEW`/`ACTIVE`.
* **Business email changes** are not self-service in V1 (it is the sign-in identity); handle through support.
* **Suspending a Sponsor account with live campaigns:** their sponsorships go dark immediately (eligibility requires an ACTIVE sponsor); payment/refund handling stays a manual owner decision. Listed in the owner-decision section of the report.
* **No multi-user teams or seats** in V1; the one-to-one model is deliberate.
* **Sponsor Intelligence (future, `sponsor_intelligence_enabled`):** any analytics must be computed from Member identities only and must exclude non-Member (Sponsor) logins; history is never rewritten.

## Terms

`lib/sponsor/terms.ts` holds `CURRENT_SPONSOR_TERMS`, deliberately `null`: **no legal text exists or is invented**. Setting it (version, effective date, href) makes the acceptance checkbox appear and required at signup and records every acceptance in `sponsor_terms_acceptances`.

## Legal records (public surface + legal closure milestone)

* **Registry:** `lib/sponsor/terms.ts` — Sponsor Terms and the Media and Advertising Agreement, each with `key`, `version`, `effectiveDate`, `status` (`DRAFT` | `APPROVED`) and a route. `CURRENT_SPONSOR_TERMS` / `CURRENT_MEDIA_AGREEMENT` are non-null **only when APPROVED**. Both ship as `DRAFT-1`, so no checkbox, acceptance or gate is active.
* **Sponsor Terms acceptance:** append-only `sponsor_terms_acceptances` (account, sponsor, document key, exact version, source `signup`|`reconsent`, time), immutable (trigger) and protected against account deletion (`ON DELETE RESTRICT`). The version is read from the server registry, never from the browser. A newer approved version is not satisfied by an older acceptance: `requireActiveSponsorAccount()` sends the Sponsor to `/sponsor/terms` to accept it first.
* **Media agreement (decision):** V1 is **in-app digital acceptance** attached to the canonical sponsorship — no external signature product. `sponsorship_agreement_acceptances` is append-only and immutable and records `sponsorship_id`, the content `revision` and material hash, which agreement and Sponsor Terms versions, and the price, currency, window and payment state in force — read by the database function `sponsor_submit_with_agreement`, which submits and records in **one transaction**. What was agreed in full is the existing immutable approval snapshot plus this row; the campaign schedule shown to the Sponsor/Super Admin is generated from the canonical record, so there is no second copy of the commercial truth. A campaign submitted by Super Admin on the Sponsor's behalf records no Sponsor acceptance. Visible only to the owning Sponsor and Super Admin (RLS + server authorization).
* **Public pages:** `/sponsorship` (public; follows the sponsorship capability — a plain "not open right now" notice when OFF, CTA unchanged because a Sponsor *application* is not a campaign), `/sponsor/terms` (public), Privacy Policy section "Sponsor accounts and sponsorships" (DRAFT).
* **One public frame:** `components/shell/PublicPageFrame.tsx` is used by Rules, Terms, Privacy, Sponsorship and Sponsor Terms. A signed-in Member on Terms/Privacy/Sponsorship sees "Open brohda."; a Sponsor sees "Sponsor dashboard"; neither sees "Log in / Create account". Rules keeps giving a Member the app shell.
* **Refund policy:** `lib/sponsorship/refund-policy.ts` (cases A–G, PROPOSED — OWNER DECISION REQUIRED); guidance on the Super Admin sponsorship page; refunds remain explicit audited actions.

## Refund policy V1 (closure milestone)

* **One decision:** `public.sponsorship_refund_evaluation(sponsorship, cause, now)` (migration 188). It reads the **canonical Game start time** (`fixtures.scheduled_start_utc`) and the **single configurable cutoff** (`platform_settings.sponsorship_refund_cutoff_hours`, default 12, bounded 0–720) and returns eligibility, a reason code, the kickoff and cutoff used, whether Super Admin must choose among options, and whether money was received. `now` is a parameter so tests control time (no sleeping). Application code calls it through `evaluateSponsorshipRefundEligibility()` (`lib/sponsorship/refund-evaluation.ts`); the browser never computes it.
* **Wording / mapping:** `lib/sponsorship/refund-policy.ts` — cases A–G, the copy a Sponsor sees, which causes apply to which campaign state. It contains no hour count (a test enforces that); every number shown comes from the evaluation.
* **Causes:** `SPONSOR_CANCELLATION` (eligible iff `now <= kickoff − cutoff`, so exactly T-cutoff is eligible), `BROHDA_REJECTED`, `BROHDA_CANCELLED_NO_BREACH` and `GAME_UNDELIVERABLE` (eligible, Super Admin offers refund or replacement), `SPONSOR_BREACH` (no automatic refund), `BROHDA_LIVE_INTERRUPTION` (undelivered portion; method pending owner), `COMPLETED_DELIVERED` (no refund), `BROHDA_NON_DELIVERY` (eligible).
* **Cancelling:** a Sponsor can now cancel a submitted, scheduled or live sponsorship **including a paid one** (previously only unpaid). `sponsor_cancel_sponsorship` leaves payment untouched, frees the inventory slot (the one-holder index only holds SUBMITTED/SCHEDULED/LIVE/SUSPENDED — independent of refund eligibility), and writes an **immutable** `sponsorship_cancellations` row: initiator, who/when, the kickoff and cutoff used, the cutoff hours, reason code, the eligibility result, money received, payment/lifecycle/review state. A later reschedule or change of the cutoff never rewrites a past decision. `admin_cancel_sponsorship` takes a **cause** from Super Admin (default `BROHDA_CANCELLED_NO_BREACH`) and snapshots the same way; the Sponsor's cutoff never applies to it. Audit rows: `sponsorship.cancelled` and, separately, `sponsorship.refund_eligibility_decided`; a refund later is its own `sponsorship.payment_refund_*` row.
* **Sponsor UX:** the sponsorship page shows the rule, the Game kickoff and the **refund cancellation deadline** (calculated on the server, displayed in the reader's time zone), whether cancelling now is refund-eligible, and requires an explicit confirmation matching that state. If the deadline passes while the Sponsor is reading, the server re-checks and refuses to cancel until they confirm the updated notice.
* **Super Admin UX:** "Refund eligibility" on each sponsorship: the frozen decision for a cancelled one, otherwise the evaluation for each applicable cause (a live suspension shows both Sponsor-breach and Brohda-caused), plus payment and refund state and, for a postponed/cancelled Game, an explicit preserve / replace / refund path using the existing Inventory, assign and refund actions.
* **Never automatic:** eligibility is not a refund. Refunds stay explicit, audited, provider-neutral Super Admin actions.
* **Provider neutrality:** no payment-processor name exists in the product's user-facing code or copy (`tests/unit/provider-neutral-copy.test.ts`); the only brand names in user-visible source are the Member wallet's payment-method labels (the monetary P2P layer — a documented, owner-decision exception).
