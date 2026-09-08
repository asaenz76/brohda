import type { ZodType } from "zod";
import type { PoolTemplate, PoolTemplateCategory } from "./types";
import {
  nflGameTotal,
  nflGameTotalConfigSchema,
  nflSpread,
  nflSpreadConfigSchema,
  nflTeamTotal,
  nflTeamTotalConfigSchema,
} from "./nfl";

// Every registry-driven template. Adding a template means writing a
// PoolTemplate definition in its own file and listing it here — nothing
// else needs to change to make it show up in the wizard. The legacy
// pool_types (WHO_WILL_ADVANCE/REGULATION_RESULT, retired/COMBO/CUSTOM)
// are deliberately NOT in this registry — their grading lives in SQL (or,
// for COMBO/CUSTOM, is manual), not gradingRule, so wrapping them here
// would be misleading.
export const TEMPLATE_REGISTRY: PoolTemplate<Record<string, unknown>>[] = [nflSpread, nflGameTotal, nflTeamTotal];

// Guards against a copy-paste mistake (two entries sharing an id+version)
// silently shadowing each other in getTemplate/getLatestTemplate — thrown at
// module load, not just documented, so it fails immediately rather than
// surfacing as a confusing grading bug later. Exported as a pure function so
// it's directly unit-testable against a synthetic list, not just this real
// registry.
export function findDuplicateTemplateKeys(templates: PoolTemplate<Record<string, unknown>>[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const t of templates) {
    const key = `${t.id}:${t.version}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

const duplicateTemplateKeys = findDuplicateTemplateKeys(TEMPLATE_REGISTRY);
if (duplicateTemplateKeys.length > 0) {
  throw new Error(`Duplicate template (id, version) pairs in TEMPLATE_REGISTRY: ${duplicateTemplateKeys.join(", ")}`);
}

// Exact-version resolution — grading (grade.ts) always resolves the exact
// version a pool was created against, even if that version is no longer
// activeForCreation, so a template's later retirement/replacement never
// changes how an already-created pool is graded.
export function getTemplate(templateId: string, version: number): PoolTemplate<Record<string, unknown>> | null {
  return TEMPLATE_REGISTRY.find((t) => t.id === templateId && t.version === version) ?? null;
}

// Creation-time resolution — the highest version among activeForCreation
// entries for this id. Returns null if the id is unknown, or every version
// of it has been retired from creation (still gradable via getTemplate).
export function getLatestTemplate(templateId: string): PoolTemplate<Record<string, unknown>> | null {
  const candidates = TEMPLATE_REGISTRY.filter((t) => t.id === templateId && t.activeForCreation);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, t) => (t.version > latest.version ? t : latest));
}

// One Zod schema per (template id, version) pair — validated against the
// client-submitted templateConfig once templateId is known (see
// createPoolFromTemplate). Kept here rather than on PoolTemplate itself so
// the interface's gradingRule/questionBuilder stay bivariantly checkable
// (see types.ts's comment) without also needing a generic schema field.
// Composite string key (not a nested map) so a duplicate (id, version) pair
// is a plain object-key collision, easy to unit-test for directly.
export const TEMPLATE_CONFIG_SCHEMAS: Record<string, ZodType> = {
  "NFL_SPREAD:1": nflSpreadConfigSchema,
  "NFL_GAME_TOTAL:1": nflGameTotalConfigSchema,
  "NFL_TEAM_TOTAL:1": nflTeamTotalConfigSchema,
};

export function getTemplateConfigSchema(templateId: string, version: number): ZodType | null {
  return TEMPLATE_CONFIG_SCHEMAS[`${templateId}:${version}`] ?? null;
}

export function listByCategory(): Partial<Record<PoolTemplateCategory, PoolTemplate<Record<string, unknown>>[]>> {
  const grouped: Partial<Record<PoolTemplateCategory, PoolTemplate<Record<string, unknown>>[]>> = {};
  for (const template of TEMPLATE_REGISTRY) {
    (grouped[template.category] ??= []).push(template);
  }
  return grouped;
}
