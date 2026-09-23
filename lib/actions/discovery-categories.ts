"use server";

import { revalidatePath } from "next/cache";
import { requireDiscoveryTaxonomyManager } from "@/lib/prediction-markets/discovery/authorization";
import { writeAuditLog } from "@/lib/audit/log";
import type { SortCriterion, SortDirection } from "@/lib/prediction-markets/discovery/ordering";
import {
  createCategory,
  createMapping,
  deleteCategory,
  deleteMapping,
  getCategoryById,
  updateCategory,
  updateMapping,
  updateSortRule,
} from "@/lib/prediction-markets/discovery/repository";
import { createCategoryMappingSchema, createDiscoveryCategorySchema, updateDiscoveryCategorySchema } from "@/lib/validations/discovery";

// Every mutation here is gated by `requireDiscoveryTaxonomyManager()`
// (lib/prediction-markets/discovery/authorization.ts) — a named capability
// boundary, never a role check. Which role satisfies that capability is
// configuration (`capability_policies`, migration 20260101000140), changed
// through `pnpm set-capability-policy`; nothing in this file knows or needs
// to know what the current answer is.

export type ActionResult = { success: boolean; error: string | null };

export async function createCategoryAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const parsed = createDiscoveryCategorySchema.safeParse({
    slug: formData.get("slug"),
    displayName: formData.get("displayName"),
    description: (formData.get("description") as string) || null,
    displayOrder: Number(formData.get("displayOrder") ?? 0),
    enabled: formData.get("enabled") === "on",
    iconKey: (formData.get("iconKey") as string) || null,
  });
  if (!parsed.success) {
    return { success: false, error: "Check the category fields — slug must be lowercase-with-hyphens, and a display name is required." };
  }

  let category;
  try {
    category = await createCategory(parsed.data);
  } catch {
    return { success: false, error: "Could not create category — the slug may already be in use." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "discovery_category.created",
    entityType: "discovery_category",
    entityId: category.id,
    after: parsed.data,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

export async function updateCategoryAction(categoryId: string, _prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const parsed = updateDiscoveryCategorySchema.safeParse({
    slug: formData.get("slug") || undefined,
    displayName: formData.get("displayName") || undefined,
    description: formData.has("description") ? (formData.get("description") as string) || null : undefined,
    displayOrder: formData.has("displayOrder") ? Number(formData.get("displayOrder")) : undefined,
    enabled: formData.has("enabled") ? formData.get("enabled") === "on" : undefined,
    iconKey: formData.has("iconKey") ? (formData.get("iconKey") as string) || null : undefined,
  });
  if (!parsed.success) {
    return { success: false, error: "Check the category fields." };
  }

  const before = await getCategoryById(categoryId);
  if (!before) return { success: false, error: "Category not found." };

  let category;
  try {
    category = await updateCategory(categoryId, parsed.data);
  } catch {
    return { success: false, error: "Could not update category." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "discovery_category.updated",
    entityType: "discovery_category",
    entityId: category.id,
    before,
    after: category,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

/** Explicit, minimal enable/disable toggle — the single most common taxonomy edit, kept as its own fast action rather than requiring a full edit-form round trip. */
export async function setCategoryEnabledAction(categoryId: string, enabled: boolean): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const before = await getCategoryById(categoryId);
  if (!before) return { success: false, error: "Category not found." };

  const category = await updateCategory(categoryId, { enabled });

  await writeAuditLog({
    actorId: admin.id,
    action: enabled ? "discovery_category.enabled" : "discovery_category.disabled",
    entityType: "discovery_category",
    entityId: category.id,
    before,
    after: category,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

export async function reorderCategoryAction(categoryId: string, displayOrder: number): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const before = await getCategoryById(categoryId);
  if (!before) return { success: false, error: "Category not found." };

  const category = await updateCategory(categoryId, { displayOrder });

  await writeAuditLog({
    actorId: admin.id,
    action: "discovery_category.reordered",
    entityType: "discovery_category",
    entityId: category.id,
    before: { displayOrder: before.displayOrder },
    after: { displayOrder: category.displayOrder },
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

export async function deleteCategoryAction(categoryId: string): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const before = await getCategoryById(categoryId);
  if (!before) return { success: false, error: "Category not found." };

  await deleteCategory(categoryId);

  await writeAuditLog({
    actorId: admin.id,
    action: "discovery_category.deleted",
    entityType: "discovery_category",
    entityId: categoryId,
    before,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

export async function createCategoryMappingAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const parsed = createCategoryMappingSchema.safeParse({
    categoryId: formData.get("categoryId"),
    provider: formData.get("provider"),
    providerTag: formData.get("providerTag"),
    enabled: formData.get("enabled") === "on",
  });
  if (!parsed.success) {
    return { success: false, error: "Check the mapping fields — category, provider, and provider tag are all required." };
  }

  let mapping;
  try {
    mapping = await createMapping(parsed.data);
  } catch {
    return { success: false, error: "Could not create mapping — this provider tag may already be mapped." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "discovery_category_mapping.created",
    entityType: "discovery_category_provider_mapping",
    entityId: mapping.id,
    after: parsed.data,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

export async function setMappingEnabledAction(mappingId: string, enabled: boolean): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const mapping = await updateMapping(mappingId, { enabled });

  await writeAuditLog({
    actorId: admin.id,
    action: enabled ? "discovery_category_mapping.enabled" : "discovery_category_mapping.disabled",
    entityType: "discovery_category_provider_mapping",
    entityId: mapping.id,
    after: mapping,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

export async function deleteMappingAction(mappingId: string): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  await deleteMapping(mappingId);

  await writeAuditLog({
    actorId: admin.id,
    action: "discovery_category_mapping.deleted",
    entityType: "discovery_category_provider_mapping",
    entityId: mappingId,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}

export async function updateSortRuleAction(
  criterion: SortCriterion,
  patch: { priority?: number; direction?: SortDirection; enabled?: boolean },
): Promise<ActionResult> {
  const admin = await requireDiscoveryTaxonomyManager();

  const rule = await updateSortRule(criterion, patch);

  await writeAuditLog({
    actorId: admin.id,
    action: "discovery_sort_policy.updated",
    entityType: "discovery_sort_policy",
    entityId: criterion,
    after: rule,
  });

  revalidatePath("/admin/discovery-categories");
  revalidatePath("/markets");
  return { success: true, error: null };
}
