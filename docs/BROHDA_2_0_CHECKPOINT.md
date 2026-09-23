# Brohda 2.0 — Integration Checkpoint (Milestone R13.6)

This document records the state of the Brohda 2.0 social prediction
network at the moment of its first integration checkpoint. It is a
point-in-time record, not living documentation — see
`docs/BROHDA_2_0_MILESTONE_MAP.md` for the canonical, ongoing milestone
authority.

## Checkpoint identity

- Milestone: R13.6 — Brohda 2.0 Integration Checkpoint
- Branch: `brohda/prediction-network-m0-m2`
- Pre-checkpoint base commit: `c4d5b5502651625722f1114546dc92d43c17be27`
- Checkpoint commit: `THIS_COMMIT`

The checkpoint commit SHA above is a placeholder at the time this file
was written, since the commit it describes does not exist yet. The real
SHA is reported in the Milestone R13.6 completion report. This file is
never amended after the commit merely to fill in its own SHA.

## What this checkpoint includes

The complete accumulated Brohda 2.0 implementation from Milestone R1
through Milestone R13.5:

- Game ↔ Market foundation and sports Market ingestion (R1–R2)
- Post and Community/distribution (R3–R4)
- Pick editing and locking (R5)
- Post conversation / comments (R6)
- Free Call BS Challenges (R7)
- Wallet reservation layer (R8)
- Monetary Challenge + Position, and P2P settlement (R9–R10)
- Reputation + leaderboards, including the R13.5 Call BS reputation
  dedup fix (R11, R13.5)
- Admin + configuration surface (R12)
- Security hardening and production lifecycle automation (R13, R13.5)
- Corresponding tests (unit, integration, E2E), operations
  documentation, and the CI production-build gate

## Readiness verdicts carried into this checkpoint

As of Milestone R13.5:

- R13.5 IMPLEMENTATION: PASS
- SOCIAL TECHNICAL READINESS: GO
- MONETARY P2P TECHNICAL READINESS: GO
- PRODUCTION OPERATIONS READINESS: GO

## What this checkpoint explicitly does NOT include or claim

- Hosted/production Supabase has NOT been mutated. Production remains on
  its pre-Brohda-2.0 legacy-pools-only schema (the R1–R13.5 migrations
  in this checkpoint have not been applied there).
- No live cron-job.org entries have been created. `docs/DEPLOYMENT.md`
  still documents that these must be created during actual deployment.
- The Milestone R5 "kickoff moved / postponed / canceled / abandoned"
  edge-case policy decision remains open (NOT_STARTED), as originally
  deferred — this checkpoint does not resolve it.
- Milestone R14 (legacy pool wind-down / repository cleanup) has not
  been started and is not authorized by this checkpoint.
- No production deployment, no main-branch merge, and no external USDT
  movement occurred as part of this checkpoint.

## Verification

Local verification for this checkpoint (lint, typecheck, unit,
integration, E2E, production build) is detailed in the Milestone R13.6
completion report, run from a freshly reset local Supabase database.
