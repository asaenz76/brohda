import { z } from "zod";

// Discovery taxonomy admin input validation — mirrors this codebase's
// existing convention (lib/validations/pools.ts): xSchema naming,
// z.infer-derived types, inline reasoning for constraints.

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const createDiscoveryCategorySchema = z.object({
  slug: z.string().min(1).max(60).regex(slugPattern, "Use lowercase letters, numbers, and hyphens only"),
  displayName: z.string().min(1).max(80),
  // Nullable, not optional — the action always passes an explicit `null`
  // for "no value" rather than omitting the key, matching what
  // createCategory()/updateCategory() (lib/prediction-markets/discovery/
  // repository.ts) expect.
  description: z.string().max(500).nullable(),
  displayOrder: z.number().int().min(0).max(10_000),
  enabled: z.boolean(),
  iconKey: z.string().max(60).nullable(),
});
export type CreateDiscoveryCategoryInput = z.infer<typeof createDiscoveryCategorySchema>;

export const updateDiscoveryCategorySchema = createDiscoveryCategorySchema.partial();
export type UpdateDiscoveryCategoryInput = z.infer<typeof updateDiscoveryCategorySchema>;

export const createCategoryMappingSchema = z.object({
  categoryId: z.string().uuid(),
  provider: z.string().min(1).max(60),
  providerTag: z.string().min(1).max(120),
  enabled: z.boolean(),
});
export type CreateCategoryMappingInput = z.infer<typeof createCategoryMappingSchema>;
