import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { TemplateFixtureRow } from "./grade";
import type { GradingEvidenceItem } from "./types";

export interface ResolvedNflFixtureRow {
  fixtureRow: TemplateFixtureRow;
  resultEvidence?: GradingEvidenceItem;
}

/**
 * The confirmed-result gate for NFL grading: gradeTemplatePool must never
 * read the raw, live-syncing fixtures.regulation_*_score for an NFL
 * fixture directly — only a CONFIRMED/CORRECTED row in nfl_game_results
 * (populated by lib/sports-data/sync-nfl.ts) may back grading. Draft/
 * provisional scores (fixtures.internal_status already COMPLETED, but no
 * confirmed row yet) must never settle a pool. No-ops immediately for any
 * other provider — football's grading path is completely untouched.
 *
 * Called from both callers of gradeTemplatePool (lib/pools/settle.ts's
 * cron and lib/actions/pool-lifecycle.ts's "Check result now" admin
 * action) — gradingRule itself stays a pure synchronous function fed only
 * by data the caller already resolved, so this substitution has to happen
 * here, one level up, not inside any individual template.
 */
export async function resolveNflFixtureRow(
  admin: ReturnType<typeof createAdminClient>,
  fixtureId: string,
  provider: string,
  fixtureRow: TemplateFixtureRow,
): Promise<ResolvedNflFixtureRow> {
  if (provider !== "api_nfl") {
    return { fixtureRow };
  }

  const { data: current } = await admin
    .from("nfl_game_results")
    .select("id, home_final_score, away_final_score, confirmed_at")
    .eq("fixture_id", fixtureId)
    .eq("is_current", true)
    .maybeSingle();

  if (!current) {
    // No confirmed result yet — even if fixtures.internal_status is
    // already COMPLETED, nulling both scores forces the existing
    // pendingIfMissing() PENDING branch every NFL template already has,
    // with zero template-level special-casing.
    return {
      fixtureRow: { ...fixtureRow, regulation_home_score: null, regulation_away_score: null },
    };
  }

  return {
    fixtureRow: {
      ...fixtureRow,
      regulation_home_score: current.home_final_score,
      regulation_away_score: current.away_final_score,
    },
    resultEvidence: {
      source: "NFL_GAME_RESULT",
      field: "nfl_game_results_id",
      rawValue: current.id,
      normalizedValue: { confirmedAt: current.confirmed_at },
    },
  };
}
