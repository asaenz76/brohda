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
