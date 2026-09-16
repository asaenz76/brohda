import { requireDiscoveryTaxonomyManager } from "@/lib/prediction-markets/discovery/authorization";
import { listAllCategories, listAllMappings, listAllSortRules } from "@/lib/prediction-markets/discovery/repository";
import { reorderCategoryAction } from "@/lib/actions/discovery-categories";
import { CategoryToggle } from "./category-toggle";
import { CategoryDeleteButton } from "./category-delete-button";
import { CreateCategoryForm } from "./create-category-form";
import { CreateMappingForm } from "./create-mapping-form";
import { MappingRowActions } from "./mapping-row-actions";
import { OrderInput } from "./order-input";
import { SortRuleControls } from "./sort-rule-controls";

// Discovery taxonomy admin (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
// Milestone 2, STEP 6 — "the smallest protected taxonomy management
// surface"). Plain server-rendered tables, no shared DataTable framework,
// matching app/(admin)/admin/invitations/page.tsx's own convention.
//
// Gated by requireDiscoveryTaxonomyManager() (lib/prediction-markets/
// discovery/authorization.ts): the page's own access gate goes through the
// same named capability every mutating action does, so the configured
// policy (`capability_policies`) governs the page and its actions
// identically, with nothing here encoding a role.

export default async function DiscoveryCategoriesPage() {
  await requireDiscoveryTaxonomyManager();

  const [categories, mappings, sortRules] = await Promise.all([listAllCategories(), listAllMappings(), listAllSortRules()]);
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const nextDisplayOrder = categories.length > 0 ? Math.max(...categories.map((c) => c.displayOrder)) + 1 : 0;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Discovery Categories</h1>

      <CreateCategoryForm nextDisplayOrder={nextDisplayOrder} />

      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Order</th>
              <th className="px-3 py-2 font-medium">Slug</th>
              <th className="px-3 py-2 font-medium">Display name</th>
              <th className="px-3 py-2 font-medium">Enabled</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {categories.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-text-muted">
                  No discovery categories configured yet.
                </td>
              </tr>
            )}
            {categories.map((category) => (
              <tr key={category.id}>
                <td className="px-3 py-2">
                  <OrderInput categoryId={category.id} value={category.displayOrder} action={reorderCategoryAction} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">{category.slug}</td>
                <td className="px-3 py-2 text-text-primary">{category.displayName}</td>
                <td className="px-3 py-2">
                  <CategoryToggle categoryId={category.id} enabled={category.enabled} />
                </td>
                <td className="px-3 py-2 text-right">
                  <CategoryDeleteButton categoryId={category.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateMappingForm categories={categories} />

      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 font-medium">Provider</th>
              <th className="px-3 py-2 font-medium">Provider tag</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {mappings.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-text-muted">
                  No provider-category mappings yet — markets will appear only under &quot;All&quot;.
                </td>
              </tr>
            )}
            {mappings.map((mapping) => (
              <tr key={mapping.id}>
                <td className="px-3 py-2 text-text-primary">{categoryById.get(mapping.categoryId)?.displayName ?? "(deleted category)"}</td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">{mapping.provider}</td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">{mapping.providerTag}</td>
                <td className="px-3 py-2 text-right">
                  <MappingRowActions mappingId={mapping.id} enabled={mapping.enabled} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold text-text-primary">Discovery ordering</p>
        <p className="mb-3 text-xs text-text-muted">
          Lower priority number applies first. The supported criteria (freshness, close time, liquidity) are fixed; their order, direction, and whether each is active are configurable.
        </p>
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Criterion</th>
                <th className="px-3 py-2 font-medium">Priority / Direction / Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {sortRules.map((rule) => (
                <tr key={rule.criterion}>
                  <td className="px-3 py-2 font-mono text-xs text-text-secondary">{rule.criterion}</td>
                  <td className="px-3 py-2">
                    <SortRuleControls criterion={rule.criterion} priority={rule.priority} direction={rule.direction} enabled={rule.enabled} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
