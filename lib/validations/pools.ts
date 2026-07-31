import { z } from "zod";

// Platform-wide guardrail: every pool needs at least this many entries by
// lock time or the lock cron auto-cancels it and refunds everyone in full
// (lib/pools/lock.ts's isBelowMinimum check against pools.min_total_entries).
// Fixed, not admin-chosen — pools created before this existed keep whatever
// lower value they were seeded with (updatePoolSchema never touches it).
// Lowered from 10 to 2 for beta testing, where pools rarely have more than a
// handful of participants.
export const MINIMUM_POOL_ENTRIES = 2;

// Enforced against a pool's linked fixture in the Server Actions that
// actually create/edit locks_at (createPoolFromTemplate, updatePoolAction) —
// not as a DB constraint, deliberately: several integration tests attach a
// pool to a fixture whose scheduled_start_utc is already in the past (to
// exercise settlement/grading against an "already happened" match) with a
// locks_at that's still in the future, which would violate a blanket DB-
// level version of this rule despite that being an intentional test setup,
// not a real admin-facing creation flow.
export const MINIMUM_LOCK_LEAD_MINUTES = 5;

const visibilityEnum = z.enum(["VISIBLE_TO_ALL_MEMBERS", "HIDDEN"]);
const participationVisibilityEnum = z.enum([
  "SHOW_BEFORE_ENTRY",
  "SHOW_AFTER_ENTRY",
  "SHOW_AFTER_LOCK",
  "NEVER_SHOW",
]);

// minTotalEntries is deliberately absent here — every pool now requires the
// platform-wide MINIMUM_POOL_ENTRIES floor (lib/actions/pools.ts), not an
// admin-chosen value, so it's no longer client-submitted input.
const sharedPoolFinancialFields = {
  entryFeeCents: z.number().int().positive(),
  houseFeeBps: z.number().int().min(0).max(10000),
  visibility: visibilityEnum,
  participationVisibility: participationVisibilityEnum,
};

const sharedPoolFields = {
  ...sharedPoolFinancialFields,
  locksAt: z.string().datetime(),
};

// The structured template builder (/admin/pools/new) only ever creates
// fixture-backed pools — every template here (including COMBO) carries a
// fixtureId, since even a COMBO prop's lock time defaults from the
// fixture's kickoff. CUSTOM (free-text, no fixture) pools are no longer
// creatable through this schema/builder — existing CUSTOM pools already in
// the database are untouched and keep grading/settling exactly as before
// (see lib/pools/templates.ts, lib/actions/pool-lifecycle.ts's
// gradeManuallyAction); this only removes the *creation* path.
//
// COMBO's title/question/legs stay admin-authored free text — unlike
// REGULATION_RESULT/WHO_WILL_ADVANCE, there's no way to derive N leg
// conditions ("Mbappé scores a goal") from fixture data automatically.
// "Yes" only wins once every leg is graded met (pool_combo_legs /
// gradeComboLegsAction), otherwise "No" wins.
export const createPoolFromTemplateSchema = z.discriminatedUnion("poolType", [
  z
    .object({
      poolType: z.enum(["WHO_WILL_ADVANCE", "REGULATION_RESULT"]),
      fixtureId: z.string().uuid(),
      ...sharedPoolFields,
    })
    .strict(),
  z
    .object({
      poolType: z.literal("COMBO"),
      fixtureId: z.string().uuid(),
      title: z.string().trim().min(1).max(200),
      question: z.string().trim().min(1).max(200),
      legs: z.array(z.string().trim().min(1).max(150)).min(2).max(10),
      ...sharedPoolFields,
    })
    .strict(),
  // templateConfig is validated loosely here (a plain object) — the
  // specific template's own config schema (e.g. winningMarginConfigSchema
  // in lib/pools/templates/goals.ts) validates its exact shape once
  // templateId is known, inside createPoolFromTemplate. Zod discriminated
  // unions can't do a nested per-value dynamic schema lookup at this level.
  z
    .object({
      poolType: z.literal("TEMPLATE_GRADED"),
      fixtureId: z.string().uuid(),
      templateId: z.string().min(1),
      templateConfig: z.record(z.string(), z.unknown()),
      ...sharedPoolFields,
    })
    .strict(),
]);

export type CreatePoolFromTemplateInput = z.infer<typeof createPoolFromTemplateSchema>;

// Backs the "multiple fixtures" wizard mode (create-the-same-template-
// across-a-round) — a coordinator configures the template/financials once
// and it's applied per fixture. COMBO is deliberately not a variant here:
// its title/question/legs are free-typed text tied to one specific match,
// so the same literal text applied to every selected fixture is never what
// an admin actually wants. TEMPLATE_GRADED's PLAYER_PROPS category is
// rejected in the action itself (lib/actions/pools.ts) rather than here —
// it needs the resolved template's category, which requires a registry
// lookup this schema doesn't have access to.
//
// Each fixture gets its own locks_at, computed from its own kickoff minus
// lockMinutesBeforeKickoff — there's no single shared absolute lock time
// the way the single-fixture flow has, since every fixture kicks off at a
// different time.
export const createPoolsForFixturesSchema = z.discriminatedUnion("poolType", [
  z
    .object({
      poolType: z.enum(["WHO_WILL_ADVANCE", "REGULATION_RESULT"]),
      fixtureIds: z.array(z.string().uuid()).min(2).max(50),
      lockMinutesBeforeKickoff: z.number().int().min(MINIMUM_LOCK_LEAD_MINUTES),
      ...sharedPoolFinancialFields,
    })
    .strict(),
  z
    .object({
      poolType: z.literal("TEMPLATE_GRADED"),
      fixtureIds: z.array(z.string().uuid()).min(2).max(50),
      lockMinutesBeforeKickoff: z.number().int().min(MINIMUM_LOCK_LEAD_MINUTES),
      templateId: z.string().min(1),
      templateConfig: z.record(z.string(), z.unknown()),
      ...sharedPoolFinancialFields,
    })
    .strict(),
]);

export type CreatePoolsForFixturesInput = z.infer<typeof createPoolsForFixturesSchema>;

// Also excludes minTotalEntries — an existing pool's minimum is left
// untouched on update (preserves pools grandfathered in under the old
// per-pool default rather than silently raising it on an unrelated edit).
export const updatePoolSchema = z
  .object({
    poolId: z.string().uuid(),
    entryFeeCents: z.number().int().positive(),
    houseFeeBps: z.number().int().min(0).max(10000),
    visibility: visibilityEnum,
    participationVisibility: participationVisibilityEnum,
    locksAt: z.string().datetime(),
  })
  .strict();

export type UpdatePoolInput = z.infer<typeof updatePoolSchema>;

export const enterPoolSchema = z
  .object({
    poolId: z.string().uuid(),
    optionId: z.string().uuid(),
    amountCents: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type EnterPoolInput = z.infer<typeof enterPoolSchema>;

export const voidEntrySchema = z
  .object({
    entryId: z.string().uuid(),
    reason: z.string().trim().min(1),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export type VoidEntryInput = z.infer<typeof voidEntrySchema>;
