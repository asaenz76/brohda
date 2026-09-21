import { z } from "zod";

// Milestone 5.5 admin operational-control input validation.

export const createKillSwitchSchema = z.object({
  scope: z.enum(["GLOBAL", "PROVIDER", "JURISDICTION", "MARKET", "USER", "COHORT"]),
  target: z.string().min(1).nullable(),
  reason: z.string().min(1).max(500),
  note: z.string().max(2000).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type CreateKillSwitchInput = z.infer<typeof createKillSwitchSchema>;

export const disableKillSwitchSchema = z.object({ id: z.string().uuid() });

export const createCohortSchema = z.object({
  key: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  mode: z.enum(["ALLOWLIST", "PERCENTAGE"]),
  percentage: z.number().int().min(0).max(100).nullable().optional(),
  rolloutSeed: z.string().min(1).nullable().optional(),
  providerScope: z.string().nullable().optional(),
  jurisdictionScope: z.string().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});
export type CreateCohortInput = z.infer<typeof createCohortSchema>;

export const setCohortEnabledSchema = z.object({ id: z.string().uuid(), enabled: z.boolean() });

export const cohortMembershipSchema = z.object({ cohortId: z.string().uuid(), userId: z.string().uuid() });

export const createLimitSchema = z.object({
  scope: z.enum(["GLOBAL", "USER", "COHORT", "JURISDICTION", "PROVIDER"]),
  target: z.string().min(1).nullable(),
  limitType: z.enum(["PER_ORDER_AMOUNT_CENTS", "DAILY_AMOUNT_CENTS", "ROLLING_AMOUNT_CENTS", "DAILY_ORDER_COUNT"]),
  thresholdValue: z.number().int().positive(),
  windowSeconds: z.number().int().positive().nullable().optional(),
});
export type CreateLimitInput = z.infer<typeof createLimitSchema>;

export const setLimitEnabledSchema = z.object({ id: z.string().uuid(), enabled: z.boolean() });

export const setProviderOverrideSchema = z.object({
  provider: z.string().min(1),
  disabled: z.boolean(),
  reason: z.string().min(1).max(500).nullable().optional(),
});
