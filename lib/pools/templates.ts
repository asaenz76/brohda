import type { NormalizedFixture } from "@/lib/sports-data/types";

export type PoolType =
  | "WHO_WILL_ADVANCE"
  | "REGULATION_RESULT"
  | "CUSTOM"
  | "COMBO"
  | "TEMPLATE_GRADED";

export interface GeneratedPoolOption {
  label: string;
  externalTeamId: string | null;
  teamName: string | null;
  logoUrl: string | null;
  sortOrder: number;
}

export interface GeneratedPoolTemplate {
  question: string;
  ruleLabel: string;
  options: GeneratedPoolOption[];
}

type TemplateFixture = Pick<
  NormalizedFixture,
  | "homeTeamExternalId"
  | "homeTeamName"
  | "homeTeamLogoUrl"
  | "awayTeamExternalId"
  | "awayTeamName"
  | "awayTeamLogoUrl"
>;

export interface TemplateEligibility {
  whoWillAdvanceEnabled: boolean;
  regulationResultEnabled: boolean;
}

/**
 * Stage gate for the "Create a pool" template picker: a Cup fixture is
 * single-elimination, so a draw is never the final outcome — only "Who
 * will advance?" makes sense. A League fixture's regular match can end in
 * a draw — only "Result after regulation" makes sense. COMBO isn't part of
 * this (it's a generic yes/no prop, unrelated to draw rules).
 *
 * An unknown competition type (not yet enriched by the provider, or a type
 * string this app doesn't recognize) stays permissive on both sides —
 * missing metadata should never silently block pool creation.
 */
export function getTemplateEligibility(competitionType: string | null): TemplateEligibility {
  if (competitionType === "Cup") {
    return { whoWillAdvanceEnabled: true, regulationResultEnabled: false };
  }
  if (competitionType === "League") {
    return { whoWillAdvanceEnabled: false, regulationResultEnabled: true };
  }
  return { whoWillAdvanceEnabled: true, regulationResultEnabled: true };
}

/** X.5.5's rule pill copy — also used when rendering an already-created
 * pool, where question/options are frozen in the DB but the badge text
 * still just depends on pool_type. */
export function getRuleLabel(poolType: PoolType): string {
  if (poolType === "WHO_WILL_ADVANCE") return "Tournament Rule: Includes Extra Time & Penalties";
  if (poolType === "REGULATION_RESULT") return "Regulation Rule: 90 Mins + Injury Time Only";
  if (poolType === "COMBO") return "All Conditions Must be met for Yes";
  if (poolType === "TEMPLATE_GRADED") return "Auto-graded from the fixture result";
  return "Custom Poll";
}

/** "System generates question/options" — spec §11.1's template step. */
export function generatePoolTemplate(
  poolType: PoolType,
  fixture: TemplateFixture,
): GeneratedPoolTemplate {
  if (poolType === "WHO_WILL_ADVANCE") {
    return {
      question: "Who will advance?",
      ruleLabel: getRuleLabel(poolType),
      options: [
        {
          label: fixture.homeTeamName,
          externalTeamId: fixture.homeTeamExternalId,
          teamName: fixture.homeTeamName,
          logoUrl: fixture.homeTeamLogoUrl,
          sortOrder: 0,
        },
        {
          label: fixture.awayTeamName,
          externalTeamId: fixture.awayTeamExternalId,
          teamName: fixture.awayTeamName,
          logoUrl: fixture.awayTeamLogoUrl,
          sortOrder: 1,
        },
      ],
    };
  }

  return {
    question: "What will the result be after regulation?",
    ruleLabel: getRuleLabel(poolType),
    options: [
      {
        label: fixture.homeTeamName,
        externalTeamId: fixture.homeTeamExternalId,
        teamName: fixture.homeTeamName,
        logoUrl: fixture.homeTeamLogoUrl,
        sortOrder: 0,
      },
      {
        label: "Draw",
        externalTeamId: null,
        teamName: null,
        logoUrl: null,
        sortOrder: 1,
      },
      {
        label: fixture.awayTeamName,
        externalTeamId: fixture.awayTeamExternalId,
        teamName: fixture.awayTeamName,
        logoUrl: fixture.awayTeamLogoUrl,
        sortOrder: 2,
      },
    ],
  };
}
