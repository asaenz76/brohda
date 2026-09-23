# BROHDA 2.0 — CANONICAL IMPLEMENTATION MILESTONE MAP

**Status: ACTIVE. This is the current implementation authority for Brohda 2.0**, superseding `docs/PRODUCT_TRANSFORMATION_ROADMAP.md`'s R1–R9 sequence (preserved there as historical context, not deleted).

This document defines the implementation sequence for Brohda 2.0 following:

- Milestone R0 — Sports Prediction Network Repivot
- Milestone R0.5 — Brohda 2.0 Architecture Reconciliation & Codebase Audit

R0.5 established the actual state of the repository.

This roadmap supersedes the previous R1-R9 implementation roadmap as the ACTIVE Brohda 2.0 roadmap.

Preserve previous roadmaps as historical documentation where useful, but they are no longer implementation authority.

**Do NOT begin any milestone merely because this roadmap has been provided.**

Each milestone requires a separate explicit implementation instruction.

---

# CANONICAL PRODUCT

Brohda is a sports-only social prediction network where sports opinions have a record.

The core interaction hierarchy is:

> Pick a side.
> Talk shit.
> Call BS.
> Put your money where your mouth is.

The product must remain fully useful without money.

A user must be able to:

- follow sports/teams/communities
- discover Games
- Pick sides
- establish a prediction record
- participate in conversation
- challenge other users for free
- build reputation

without having:

- a wallet
- USDT
- a deposit
- a Monetary Position

Money sits on top of the social prediction system.

The social prediction system never depends on money.

---

# CANONICAL DOMAIN MODEL

Target conceptual model:

    GAME
      │
      └── POST
           │
           ├── MARKET
           │    │
           │    └── PICK
           │          │
           │          └── CHALLENGE
           │                 │
           │                 └── MONETARY POSITION
           │
           └── COMMENT
                 └── COMMENT

    POST ↔ COMMUNITY DISTRIBUTION

    USER
      ├── Communities / follows
      ├── Picks
      ├── Comments
      ├── Challenges
      ├── Monetary Positions
      └── Existing USDT Wallet / Ledger

This is a semantic model.

Do not blindly create one table per box.

Reuse existing Brohda infrastructure where R0.5 proved the semantics fit.

---

# VERIFIED R0.5 BASELINE

R0.5 established:

## Existing and reusable

- `fixtures` can serve as Game.
- `predictions` can serve as Pick.
- existing prediction grading is reusable.
- existing prediction probability snapshots remain useful.
- existing profiles are reusable.
- existing user-to-user follows are reusable.
- existing sports/team following remains useful but is not itself Community.
- existing notification infrastructure is reusable.
- existing capability-policy architecture is reusable.
- existing audit/security patterns are reusable.
- existing wallet infrastructure is reusable.
- existing append-only wallet transaction ledger is reusable.
- `apply_wallet_transaction(...)` is sufficiently product-neutral to remain the low-level money-moving primitive.
- existing idempotency patterns are reusable.
- existing `SELECT ... FOR UPDATE` pessimistic-locking patterns are reusable.
- existing basis-point fee configuration provides a useful pattern.
- existing pool comments provide a useful implementation/security pattern for future Post comments.

## Existing but requiring deliberate changes

- `markets` has useful Market semantics but currently has a weak relationship to Game and no live post-R0 sports Market writer.
- Predictions are currently effectively write-once, while Brohda 2.0 requires bounded Pick editing.
- leaderboards currently derive from legacy pool outcomes rather than Brohda 2.0 Pick records.
- comments/likes are currently pool-specific.
- existing pool settlement is pari-mutuel and must NOT be generalized into P2P settlement.

## Confirmed absent

- Post
- Community
- Post-to-Community distribution
- free Challenge / Call BS
- Monetary Challenge
- P2P Monetary Position
- wallet reservation/hold mechanism
- bilateral P2P settlement

## Critical financial finding

There is currently NO reserved-balance/hold mechanism.

Brohda currently has a single wallet balance.

This means monetary Challenges MUST NOT be implemented until a proper reservation layer exists.

---

# PERMANENT POLYMARKET RULE

Polymarket remains dead.

Do NOT resurrect:

- Polymarket
- Gamma
- CLOB
- Builder
- Session Keys
- OrderIntent
- exchange execution
- exchange quotes
- slippage architecture
- Polymarket execution adapters
- Polymarket provider abstractions
- simulated exchange execution

P2P Brohda money is a new Brohda-native domain built on the existing Brohda wallet/ledger primitives.

It is NOT a revival of the abandoned exchange architecture.

---

# UNBREAKABLE ENGINEERING RULE

> NOTHING THAT DOESN'T NEED TO BE HARD-CODED SHOULD BE HARD-CODED.

Hard-code only genuine technical invariants required for:

- correctness
- security
- schema/protocol integrity
- mathematically fixed semantics
- unavoidable technical behavior

Anything that could reasonably change as product or operational policy must be configurable/data-driven.

This includes, where applicable:

- timing windows
- limits
- thresholds
- fees
- feature enablement
- supported sports
- supported leagues
- supported Market templates
- visibility
- eligibility
- challenge behavior
- challenge limits
- stake limits
- feed behavior
- Community behavior
- notification behavior
- copy
- ranking policy
- rollout
- administrative permissions

Do not interpret this rule as "put everything in `platform_settings`."

Use the appropriate configuration owner.

Every implementation milestone must contain a hard-coding audit.

A mutable founder/admin policy should not require deployment unless there is a genuine technical reason.

---

# SECURITY BASELINE

All new Brohda 2.0 domains must inherit Brohda's proven security discipline.

Prefer the established pattern:

    client
      ↓
    validated server action / controlled API
      ↓
    SECURITY DEFINER RPC where appropriate
      ↓
    transactional database operation

Do not casually introduce direct client writes to sensitive canonical objects.

Particularly sensitive operations include:

- Post creation
- Market creation
- Pick creation/change
- Pick locking
- Challenge creation
- Challenge acceptance
- Challenge expiration
- reservation
- reservation release
- Position creation
- settlement
- grading
- financial transactions

Any new table must be included in privilege/RLS hygiene review.

Financial operations must be:

- atomic
- idempotent where appropriate
- concurrency-safe
- auditable
- server-enforced

Never rely on UI state for financial or locking correctness.

---

# MILESTONE R1 — GAME ↔ MARKET FOUNDATION

## Goal

Establish the correct canonical relationship between sports truth and objectively gradeable Market propositions.

Conceptually:

    Game
      ↓
    Market

## Scope

Audit and evolve the existing `markets` domain so every sports Market has an authoritative relationship to the appropriate Game/fixture.

Resolve the current loose `provider_event_id` relationship.

Define Market identity semantics.

A Market represents a specific immutable proposition.

For example:

    Giants +6.5

and:

    Giants +5.5

must never silently become the same historical proposition if doing so would rewrite what an existing Pick meant.

Determine the appropriate schema/versioning architecture before implementation.

Preserve:

- fixtures
- predictions
- grading
- odds/probability snapshot history
- existing security patterns

Do NOT build sports Market ingestion yet.

Do NOT build Post.

Do NOT build Community.

Do NOT build Challenge.

Do NOT touch monetary architecture.

## Required decisions/gates

- Game ↔ Market relationship
- Market identity
- line-value permanence
- Market lifecycle
- push/void representation at the Market-result level
- appropriate FK/reference strategy
- migration safety

## Security gate

Only Brohda-controlled systems may create canonical Markets.

## Exit state

Brohda has a structurally correct Game → Market foundation upon which sports Market ingestion can safely operate.

---

# MILESTONE R2 — SPORTS MARKET INGESTION

## Goal

Populate canonical Brohda Markets from authoritative sports/odds data.

## Scope

Build the real non-Polymarket Market generation/ingestion pipeline.

Use existing API-Sports/sports-data infrastructure where appropriate.

Support only approved Market templates initially.

Expected initial templates:

- moneyline / winner
- spread / handicap
- total

Use actual repository/provider capabilities rather than assumptions.

Preserve odds observations/probability snapshots needed for historical context.

## Critical requirement

Sportsbook line movement must never rewrite the historical meaning of an existing Pick.

## Configurable policy

At minimum assess:

- enabled sports
- enabled leagues
- enabled templates
- bookmaker eligibility
- source-count requirements
- freshness
- aggregation
- visibility
- Market-generation rules
- fallback behavior

## Do NOT

- introduce arbitrary user-created Markets
- introduce exotic props without authorization
- create Post yet unless technically unavoidable and explicitly authorized
- introduce monetary behavior

## Exit state

Brohda can reliably generate and maintain canonical sports Markets associated with Games.

---

# MILESTONE R3 — POST FOUNDATION

## Goal

Create the canonical social representation of a Game.

Conceptually:

    Game
      ↓
    Post

## Product invariant

Only Brohda/platform may create Posts.

Users NEVER create Posts.

Normal scheduled sports should use one canonical Game Post per Game unless a future explicit product decision changes this.

## Scope

Create the minimum Post domain needed to represent a Game socially.

Determine:

- Post lifecycle
- Game relationship
- primary Market relationship
- additional Market presentation
- publication state
- visibility
- canonical URL/detail surface

A Post may contain multiple Markets.

The feed should be capable of showing a primary Market while the Post detail surface exposes additional Markets.

## Do NOT

- build Communities yet
- duplicate Posts by audience
- build Comments yet
- build Challenges
- touch money

## Exit state

A Game can have one canonical Brohda-owned social Post containing its relevant Markets.

---

# MILESTONE R4 — COMMUNITY + DISTRIBUTION

## Goal

Allow the same canonical Post to appear in multiple relevant audiences without duplication.

Conceptually:

    Post
      ├── Giants Community
      ├── Rams Community
      ├── NFL Community
      └── public feed

All point to the SAME Post.

## Scope

Define and implement Community.

Determine appropriate distinction between:

- following
- membership
- team affinity
- declared fandom
- league/sport interest

Do not silently treat existing private notification follows as public Community membership.

Implement Post-to-Community distribution.

## Critical invariant

Distribution must never clone:

- Post
- Market
- Pick
- Comment conversation
- participation counts
- Challenge state

## Configuration

Distribution eligibility/rules must be configurable where reasonably mutable.

Do not bury audience mapping policy in scattered code.

## Exit state

One canonical Post can be distributed across multiple Communities/feeds while preserving one shared conversation and prediction state.

---

# MILESTONE R5 — PICK EDITING + LOCKING

## Goal

Evolve existing write-once Prediction behavior into Brohda 2.0 Pick behavior without losing permanent prediction integrity.

## Product policy

Current desired policy:

    scheduled kickoff = T

    T-10:
      ordinary Pick editing ends
      final Pick becomes permanent prediction record
      unaccepted Challenges eventually expire

    T-5:
      Game/Markets lock

    T:
      scheduled kickoff

These VALUES are configurable policy.

Do not hard-code `10` or `5`.

## Scope

Allow users to change their Pick before the applicable Pick cutoff.

Preserve sufficient audit/history to know what ultimately became the permanent Pick.

Only the final locked Pick counts toward the permanent prediction record.

Server-side enforcement is mandatory.

Design now for future Challenge-based early locking.

## Critical future rule

An accepted Challenge will eventually lock both participants' challenged Picks immediately, even if ordinary Pick editing would otherwise remain open.

R5 must make that future constraint possible without implementing Challenge yet.

## Edge cases

Define behavior architecture for:

- kickoff moved
- postponed
- canceled
- abandoned

Do not silently invent unresolved founder policy.

## Exit state

Brohda has safe, auditable, configurable Pick editing and locking.

---

# MILESTONE R6 — POST CONVERSATION

## Goal

Add conversation to the canonical Post.

## Scope

Implement Post-scoped Comments using the proven pool-comment security/rate-limit/notification pattern where appropriate.

Support threaded replies according to the chosen architecture.

Determine whether reactions are required at all.

Do not assume legacy pool likes must be reproduced.

The Brohda product hierarchy prioritizes conversation:

    Pick a side.
    Talk shit.

## Critical invariant

Comments belong to the canonical Post.

Community distribution does not create separate conversations.

## Open question to resolve here

Whether Market-scoped discussion is genuinely necessary.

Default product model remains Post-scoped conversation unless evidence justifies additional scope.

## Moderation

Introduce appropriate moderation/admin capability rather than copying the limited pool-comment owner/admin deletion behavior blindly.

## Exit state

Every canonical Game Post can host one shared social conversation.

---

# MILESTONE R7 — FREE CALL BS CHALLENGES

## Goal

Make disagreement personal without requiring money.

## Product behavior

Both users must already have opposing Picks on the SAME Market.

Example:

    André → Giants +6.5
    Carlos → Rams -6.5

André may:

    CALL BS

Carlos may accept or decline.

No wallet required.

No money required.

## Acceptance invariant

Once accepted:

- Challenge is exclusive
- nobody else can accept that Challenge
- both challenged Picks lock immediately
- neither participant may change that challenged Pick
- Challenge remains active through grading
- Market result determines Challenge result

Unaccepted Challenges expire according to configurable policy.

Current intended policy is the Pick-change cutoff.

## Scope

Implement:

- Challenge domain
- creation
- eligibility
- acceptance
- decline
- expiration
- Pick locking
- grading
- head-to-head result
- notifications
- profile/history implications where appropriate

## Security

Must prevent:

- self-challenge
- same-side Challenge
- mismatched Market
- duplicate acceptance
- acceptance after expiration
- Pick mutation after acceptance
- forged Challenge result
- unauthorized mutation

## Money

ZERO wallet dependency.

ZERO ledger mutation.

ZERO Monetary Position.

## Exit state

Two users with opposing Picks can complete a fully functional free head-to-head Challenge.

---

# MILESTONE R8 — WALLET RESERVATION LAYER

## Goal

Build the missing financial primitive required before monetary Challenges can safely exist.

This milestone is intentionally independent from monetary Challenge UX.

## Verified starting point

Current Brohda wallet has:

    balance

but no structural concept equivalent to:

    available
    reserved/held

R0.5 proved this gap.

## Required semantics

Example:

    total usable funds = 100
    reserve = 20

Result:

    available = 80
    reserved = 20

Reserved funds cannot be spent elsewhere.

## Scope

Design and implement a robust reservation/hold mechanism using the existing wallet/ledger infrastructure.

Determine the safest architecture:

- dedicated holds/reservations
- computed available balance
- ledger-based reservation
- another evidence-based design

Do not assume a specific schema from this roadmap.

## Required operations

At minimum:

- reserve
- release
- commit/consume
- query available balance
- query reserved balance where appropriate

## Requirements

Operations must be:

- atomic
- idempotent
- concurrency-safe
- auditable

Reuse:

- existing wallet
- existing ledger
- `apply_wallet_transaction(...)` where semantically correct
- proven row-locking patterns

Do not create a second wallet system.

## Required race testing

Must prove:

    balance = 20

    challenge/reservation A = 20
    concurrent reservation B = 20

Only one may succeed.

## No monetary Challenges yet

This milestone creates the financial primitive only.

## Exit state

Brohda can safely reserve and release internal USDT funds without double spending.

---

# MILESTONE R9 — MONETARY CHALLENGE + POSITION

## Goal

Allow opposing users to put money behind their Picks.

Conceptual action:

> Put your money where your mouth is.

Exact consumer-facing button/copy is NOT an architectural invariant.

## Preconditions

R7 free Challenge infrastructure exists.

R8 reservation infrastructure exists.

## Required behavior

A monetary challenge may eventually originate:

- from an accepted free Call BS Challenge
- directly between users with opposing Picks

Both pathways must preserve the same core safety rules.

## Challenger

Must have full proposed stake available before sending.

Sending reserves the stake immediately.

Example:

    available = 100
    proposed stake = 20

after send:

    available = 80
    reserved = 20

## Recipient

Does NOT need an active/funded wallet merely to receive the challenge.

If insufficiently funded:

- Challenge remains visible
- required balance is explained
- funding path may be offered
- free Call BS remains possible where applicable

Funding does NOT equal acceptance.

After funding, recipient must explicitly accept while the Challenge remains valid.

## Acceptance

Must atomically re-check:

- Challenge validity
- expiration
- Market state
- Pick state
- immutable terms
- recipient available balance

Then reserve the recipient's equal stake and create/commit the Monetary Position.

## Decline/expiration

Must atomically release challenger reservation.

## Scope

Implement:

- monetary challenge terms
- reservation integration
- recipient funding state
- acceptance
- decline
- expiration
- Position creation
- notifications
- admin/audit visibility

## Do NOT

Implement final payout/settlement logic here beyond what is necessary to represent a committed Position safely.

Settlement belongs to R10.

## Exit state

Brohda can safely create a fully funded bilateral Monetary Position between users with opposing Picks.

---

# MILESTONE R10 — P2P SETTLEMENT

## Goal

Resolve committed Monetary Positions from objectively graded Market results.

## Scope

Build bilateral settlement logic.

Do NOT reuse pari-mutuel pool settlement math.

Reuse the underlying generic financial primitives where appropriate.

Conceptually:

    Game final
      ↓
    Market resolved
      ↓
    Picks graded
      ↓
    Challenge graded
      ↓
    Monetary Position resolved
      ↓
    stake settlement
      ↓
    configurable Brohda fee
      ↓
    ledger update

## Push/void

Canonical starting rule:

A true objective push on an eligible spread/total Market should resolve the Market as VOID for Pick/Challenge purposes rather than inventing a winner.

Monetary settlement must safely return/release the applicable committed funds according to the Position settlement model.

Template-specific objective resolution semantics may be true invariants.

Mutable financial policy must remain configurable.

## Provider correction

This milestone must explicitly resolve policy/architecture for:

- corrected final score
- correction before settlement
- correction after settlement

Do not silently choose irreversible behavior.

## Requirements

Settlement must be:

- atomic
- idempotent
- concurrency-safe
- auditable

A Position must never settle twice.

Fees must never apply twice.

## Exit state

Committed P2P Monetary Positions can be deterministically and safely settled from canonical sports results.

---

# MILESTONE R11 — REPUTATION + LEADERBOARDS

## Goal

Turn Picks and Challenges into durable social reputation.

## Existing foundation

Prediction factual aggregates already exist but were deliberately left inactive.

Legacy leaderboards currently derive from pool outcomes.

Do not blindly merge those concepts.

## Scope

Activate Brohda 2.0 factual reputation from:

- Pick correctness
- Pick history
- sport
- league
- Market type
- probability/difficulty context where useful
- Challenge results
- head-to-head history

Determine how legacy pool outcomes coexist with or remain separate from Brohda 2.0 reputation.

## Principle

Reputation should reflect actual historical behavior.

Do not create opaque fake expertise scores without a separately approved product model.

## Exit state

Profiles and leaderboards reflect meaningful Brohda 2.0 prediction and challenge history.

---

# MILESTONE R12 — ADMIN + CONFIGURATION

## Goal

Ensure Brohda 2.0 can be operated without source-code edits for mutable product policy.

This milestone is NOT permission to postpone configuration until R12.

Every earlier milestone must make its own mutable policy configurable from the start.

R12 provides the coherent operational/admin surface over that configuration.

## Scope

Admin capabilities should cover appropriate configuration/inspection for:

- sports
- leagues
- Market templates
- Market generation
- Post publication
- Community configuration
- distribution
- Pick timing
- Challenge policy
- Challenge limits
- monetary enablement
- stake limits
- reservation diagnostics
- fee policy
- settlement diagnostics
- notifications
- moderation
- rollout/feature flags

Use capability-based authorization.

Audit all changes.

## Hard-coding audit

Perform a repository-wide Brohda 2.0 policy audit.

Goal:

> Hard-coded mutable policy remaining: NONE

## Exit state

Brohda 2.0 is operationally configurable without requiring deployments for ordinary product-policy changes.

---

# MILESTONE R13 — SECURITY, ABUSE & PRODUCTION READINESS

## Goal

Prove the complete Brohda 2.0 system is safe and operationally coherent before production activation.

## Scope

Perform adversarial review of:

- Posts
- Markets
- Picks
- Comments
- Communities
- Challenges
- reservations
- Monetary Positions
- grading
- settlement
- fees
- wallet operations
- notifications
- admin capabilities

## Financial adversarial cases

At minimum test:

- double reservation
- concurrent Challenge acceptance
- expired Challenge acceptance
- insufficient funds
- repeated settlement
- repeated release
- forged client balance
- forged Pick state
- forged Challenge state
- forged Market result
- provider correction
- interrupted transaction
- retry/idempotency
- privilege escalation

## Social abuse

Assess:

- comment spam
- harassment/reporting needs
- Challenge spam
- notification abuse
- user blocking implications
- moderation
- rate limits

Do not invent unnecessary product complexity, but identify genuine production blockers.

## Operational readiness

Verify:

- scheduled jobs
- monitoring
- diagnostics
- failure recovery
- auditability
- configuration
- admin controls
- migration safety
- rollback strategy

## Exit state

Brohda 2.0 is technically ready for a separately authorized production rollout.

This milestone does NOT itself authorize deployment.

---

# MILESTONE R13.5 — PRODUCTION OPERATIONS GATE

Not part of the original roadmap — inserted after R13 to resolve the two
specific blockers R13's own completion report identified:

    R13 IMPLEMENTATION: PASS
    SOCIAL TECHNICAL READINESS: GO
    MONETARY P2P TECHNICAL READINESS: GO
    PRODUCTION OPERATIONS READINESS: NO-GO

## Goal

Resolve Call BS reputation farming (PRODUCT / ABUSE DECISION REQUIRED)
and automate Brohda's three unscheduled production-critical lifecycle
jobs (PRODUCTION OPERATIONS DECISION REQUIRED) — grading, Call BS
resolution, P2P settlement — so the complete social and monetary
lifecycle can operate continuously in production without a human
manually running core lifecycle commands.

## Scope

- Call BS reputation dedup: one Pick may contribute at most one Call BS
  reputation result against the same opponent. Raw Challenge history
  stays intact; only the counted reputation result deduplicates.
- Production cron routes for grading, Call BS resolution, and P2P
  settlement, using the existing `recordJobRun`/`try_acquire_cron_lock`
  architecture — no new scheduler, lock, or job-history mechanism.
- Per-item failure isolation for grading and Challenge resolution
  (settlement already had it).
- Grading/Challenge-resolution batch sizes moved into
  `platform_settings`, mirroring R12's own `settlement_batch_size`
  precedent.
- Production build added to CI as a required gate.

## Exit state

See `docs/architecture/production-operations-gate.md` for the full
design, regression proof, and readiness reassessment.

---

# MILESTONE R13.6 — BROHDA 2.0 INTEGRATION CHECKPOINT

Not a product or security milestone. A controlled, audited git checkpoint
of the complete accumulated R1–R13.5 implementation onto the existing
`brohda/prediction-network-m0-m2` branch.

## Goal

Inventory, audit, and deliberately commit exactly the Brohda 2.0
implementation/tests/documentation/required-infrastructure accumulated
across R1–R13.5 — excluding generated artifacts, local/secret material,
and pre-existing unrelated work — then push that single commit and
verify GitHub CI is green for that exact SHA.

## Scope

- Full file inventory (implementation / tests / docs / infrastructure vs.
  generated / local-secret / pre-existing-unrelated / unknown).
- Secret scan, generated-artifact audit, package/lockfile audit, migration
  inventory and content audit, architecture-documentation audit.
- Full accumulated-diff review for debug artifacts, disabled tests, and
  bypassed authorization.
- Fresh local verification (lint, typecheck, unit, integration, E2E,
  production build) from a reset local Supabase.
- One deliberate checkpoint commit, pushed to the existing feature branch
  only.

## Explicit non-goals

No R14. No deployment. No hosted Supabase mutation. No live cron-job.org
entries. No external USDT movement. No merge to `main`. No product,
financial, or reputation policy changes. No opportunistic refactoring or
cleanup.

## Status

Checkpoint created and verified locally; remote push/CI status is
reported in the Milestone R13.6 completion report, not in this document.
This entry is not marked COMPLETE here — the completion report is
authoritative for final remote state.

---

# MILESTONE R14 — LEGACY POOL WIND-DOWN & REPOSITORY CLEANUP

## Goal

Only after Brohda 2.0 is proven should the legacy pool product be considered for deliberate retirement.

This milestone is NOT automatically authorized.

## Scope

Audit actual dependencies after Brohda 2.0 is complete.

Determine what legacy product code can safely be removed while preserving shared infrastructure.

Critical distinction:

    legacy pool PRODUCT
        may eventually disappear

    shared wallet/ledger/security infrastructure
        remains

Do not delete shared infrastructure merely because it originated in the pool era.

## Potential areas

- pools
- pool options
- entries
- pari-mutuel settlement
- pool comments/likes superseded by Post equivalents
- old pool leaderboard logic
- legacy routes
- legacy admin
- dead tests
- obsolete configuration
- obsolete documentation

## Exit state

Repository reflects the Brohda 2.0 product cleanly without carrying unnecessary legacy product complexity.

---

# CROSS-MILESTONE RULE — CONFIGURATION

Every milestone must explicitly classify new behavior as:

    TRUE INVARIANT
    CONFIGURABLE PRODUCT POLICY
    CONFIGURABLE OPERATIONAL POLICY
    PROVIDER-DERIVED VALUE
    TEMPLATE RULE
    USER/OBJECT STATE

Every milestone completion report must include:

    Hard-coded mutable policy remaining:
    Founder/admin changes requiring deployment:

Expected answer when technically possible:

    Hard-coded mutable policy remaining: NONE
    Founder/admin changes requiring deployment: NONE

Exceptions require explicit technical justification.

---

# CROSS-MILESTONE RULE — MIGRATIONS

For every migration:

- inspect current migration head first
- never rewrite shipped production migrations
- use additive forward migrations where required
- preserve production data
- verify grants/RLS
- verify rollback/recovery implications
- extend privilege-hygiene tests
- document migration dependencies

Never create speculative schema merely because a later milestone may need it.

Implement schema when its owning milestone requires it.

---

# CROSS-MILESTONE RULE — MONEY

The social prediction system must never require a wallet.

The wallet system must remain separate from Pick semantics.

Canonical conceptual layering:

    PICK
      ↓ optional
    CHALLENGE
      ↓ optional
    MONETARY POSITION
      ↓
    RESERVATION
      ↓
    SETTLEMENT

A Pick is not money.

A Challenge is not money by definition.

A Monetary Position is the economic contract.

Settlement resolves the Monetary Position.

Do not allow financial concepts to contaminate basic prediction participation.

---

# CROSS-MILESTONE RULE — SPORTS TRUTH

Game is sports truth.

Sports provider data determines objective event facts.

Market resolution must be deterministic from authoritative sports data wherever possible.

Do not use manual editorial resolution when structured provider data can safely resolve the Market.

Provider corrections and unsupported/ambiguous outcomes require explicit handling rather than guesses.

---

# CROSS-MILESTONE RULE — SOCIAL TRUTH

Post is conversation.

Market is the question.

Pick is the opinion.

Community determines distribution/affinity.

Comment is conversation.

Challenge makes disagreement personal.

Monetary Position makes disagreement economic.

Settlement resolves the economic contract.

Keep these responsibilities separate.

---

# CROSS-MILESTONE RULE — ONE CANONICAL OBJECT

Do not duplicate canonical state merely for presentation.

One Game.

One canonical Game Post.

One Market proposition/version.

One user's applicable Pick on that Market.

One shared Post conversation.

Community/feed distribution references those objects.

Do not create audience-specific copies merely because the same object appears in multiple feeds.

---

# CROSS-MILESTONE RULE — VERIFICATION

Every implementation milestone must finish with relevant verification.

At minimum assess:

- lint
- typecheck
- unit tests
- integration tests
- relevant E2E tests
- security/privilege tests
- build

Financial milestones require dedicated concurrency/idempotency tests.

Do not weaken tests to obtain green.

---

# CROSS-MILESTONE RULE — PRODUCTION SAFETY

Unless a future milestone explicitly authorizes otherwise:

- no hosted Supabase mutation
- no production mutation
- no deployment
- no push unless explicitly authorized
- no live wallet mutation
- no external money movement

Each milestone must report these explicitly.

---

# CROSS-MILESTONE RULE — SCOPE CONTROL

Do not automatically begin the next milestone.

Do not implement future milestone functionality merely because it seems convenient.

If a prerequisite belonging to a future milestone is discovered:

STOP where appropriate and report it.

Do not silently expand scope.

Small, independently verifiable milestones are preferred over large transformations.

Financial/security boundaries must never be hidden inside generic product milestones.

---

# ACTIVE IMPLEMENTATION ORDER

The canonical implementation sequence is now:

    R0     Sports Prediction Network Repivot                  COMPLETE
    R0.5   Brohda 2.0 Architecture Reconciliation            COMPLETE
    R1     Game ↔ Market Foundation                          COMPLETE
    R2     Sports Market Ingestion                           COMPLETE
    R3     Post Foundation                                   COMPLETE
    R4     Community + Distribution                          COMPLETE
    R5     Pick Editing + Locking                             COMPLETE
    R6     Post Conversation                                   COMPLETE
    R7     Free Call BS Challenges                              COMPLETE
    R8     Wallet Reservation Layer                              COMPLETE
    R9     Monetary Challenge + Position                          COMPLETE
    R10    P2P Settlement                                          COMPLETE
    R11    Reputation + Leaderboards                                COMPLETE
    R12    Admin + Configuration                                    COMPLETE
    R13    Security, Abuse & Production Readiness                   COMPLETE
    R13.5  Production Operations Gate                                COMPLETE
    R13.6  Brohda 2.0 Integration Checkpoint                 see completion report

    R14    Legacy Pool Wind-Down & Repository Cleanup

R14 remains conditional and requires explicit authorization.
