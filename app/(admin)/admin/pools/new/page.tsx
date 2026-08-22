import { requireSuperAdmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getPoolFeeDefaults } from "@/lib/settings/pool-defaults";
import { formatBps } from "@/lib/utils/money";
import { getLatestTemplate } from "@/lib/pools/templates/registry";
import { PoolTemplateBuilder, type DuplicateTemplate } from "./pool-template-builder";
import { buildCompetitionOptions } from "./template-cards";

// Converts a TEMPLATE_GRADED pool's typed template_config JSON back into
// the wizard's Record<string,string> shape (every config input is a plain
// text/number/toggle field bound to a string). PLAYER-type fields are
// skipped — the original player is tied to the source fixture's roster and
// almost certainly isn't on whatever new fixture the admin picks; the
// template itself still pre-selects, but PlayerPicker starts empty so the
// admin picks a real player from the new fixture's actual squad.
function templateConfigToConfigValues(
  templateId: string,
  config: Record<string, unknown>,
): Record<string, string> {
  const template = getLatestTemplate(templateId);
  if (!template) return {};
  const values: Record<string, string> = {};
  for (const field of template.requiredConfigFields) {
    if (field.type === "PLAYER") continue;
    const raw = config[field.key];
    if (raw === undefined || raw === null) continue;
    values[field.key] = String(raw);
  }
  return values;
}

export default async function NewPoolPage({
  searchParams,
}: {
  searchParams: Promise<{ duplicateFrom?: string; fixtureId?: string }>;
}) {
  await requireSuperAdmin();
  const supabase = await createClient();
  const poolFeeDefaults = await getPoolFeeDefaults();
  const { duplicateFrom, fixtureId } = await searchParams;

  // "Duplicate this pool" — pre-fills the wizard's template/financial
  // config from an existing pool for a *new* fixture (the fixture itself
  // is never duplicated, that's still picked fresh in Step 1). Silently
  // ignored if the source pool is missing or is a CUSTOM pool (no wizard
  // equivalent) — lands on a fresh wizard rather than erroring.
  let duplicateTemplate: DuplicateTemplate | null = null;
  let duplicateEntryFee: string | null = null;
  let duplicateHouseFeePercent: string | null = null;
  let duplicateVisibility: string | null = null;
  let duplicateParticipationVisibility: string | null = null;

  if (duplicateFrom) {
    const { data: sourcePool } = await supabase
      .from("pools")
      .select(
        "pool_type, template_id, template_config, entry_fee, house_fee_bps, visibility, participation_visibility, title, question",
      )
      .eq("id", duplicateFrom)
      .single();

    if (sourcePool && sourcePool.pool_type !== "CUSTOM") {
      duplicateEntryFee = (sourcePool.entry_fee / 100).toFixed(2);
      duplicateHouseFeePercent = formatBps(sourcePool.house_fee_bps).replace("%", "");
      duplicateVisibility = sourcePool.visibility;
      duplicateParticipationVisibility = sourcePool.participation_visibility;

      let legs: string[] | null = null;
      if (sourcePool.pool_type === "COMBO") {
        const { data: comboLegs } = await supabase
          .from("pool_combo_legs")
          .select("label")
          .eq("pool_id", duplicateFrom)
          .order("sort_order");
        legs = (comboLegs ?? []).map((leg) => leg.label);
      }

      duplicateTemplate = {
        poolType: sourcePool.pool_type,
        templateId: sourcePool.template_id,
        configValues:
          sourcePool.pool_type === "TEMPLATE_GRADED" && sourcePool.template_id
            ? templateConfigToConfigValues(
                sourcePool.template_id,
                (sourcePool.template_config as Record<string, unknown>) ?? {},
              )
            : null,
        title: sourcePool.title,
        question: sourcePool.question,
        legs,
      };
    }
  }

  // Excludes any fixture whose every pool has already been graded (SETTLED/
  // CANCELLED/VOIDED) — nothing left to attach a new pool to. Team name/
  // logo/external-id fields are fetched (not just the display label) so the
  // client can run the exact same generatePoolTemplate() question/options
  // logic locally for a live preview, without a server round trip per pick.
  const { data: fixtures } = await supabase
    .from("fixtures_available_for_pool_creation")
    .select(
      "id, external_fixture_id, home_team_external_id, home_team_name, home_team_logo_url, away_team_external_id, away_team_name, away_team_logo_url, competition_name, competition_country, competition_type, sport, provider, competition_external_id, season, scheduled_start_utc",
    )
    .order("scheduled_start_utc", { ascending: true });

  const fixtureOptions = (fixtures ?? []).map((f) => {
    const league = f.competition_name
      ? f.competition_country
        ? `${f.competition_country} | ${f.competition_name}`
        : f.competition_name
      : null;
    return {
      id: f.id,
      externalFixtureId: f.external_fixture_id,
      homeTeamExternalId: f.home_team_external_id,
      homeTeamName: f.home_team_name,
      homeTeamLogoUrl: f.home_team_logo_url,
      awayTeamExternalId: f.away_team_external_id,
      awayTeamName: f.away_team_name,
      awayTeamLogoUrl: f.away_team_logo_url,
      competitionType: f.competition_type,
      sport: f.sport,
      provider: f.provider,
      league,
      label: `${f.home_team_name} vs ${f.away_team_name}${league ? ` (${league})` : ""} — ${new Date(
        f.scheduled_start_utc,
      ).toLocaleString()}`,
      scheduledStartUtc: f.scheduled_start_utc,
      competitionKey:
        f.competition_external_id && f.season ? `${f.provider}:${f.competition_external_id}:${f.season}` : null,
    };
  });
  const competitionOptions = buildCompetitionOptions(fixtureOptions);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-text-primary">Create a pool</h1>
      <PoolTemplateBuilder
        fixtures={fixtureOptions}
        competitions={competitionOptions}
        initialFixtureId={fixtureId}
        defaultEntryFee={duplicateEntryFee ?? (poolFeeDefaults.entryFeeCents / 100).toFixed(2)}
        defaultHouseFeePercent={
          duplicateHouseFeePercent ?? formatBps(poolFeeDefaults.houseFeeBps).replace("%", "")
        }
        defaultTierEntryFees={poolFeeDefaults.tierEntryFeesCents.map((cents) => (cents / 100).toFixed(2))}
        defaultVisibility={duplicateVisibility ?? undefined}
        defaultParticipationVisibility={duplicateParticipationVisibility ?? undefined}
        duplicateTemplate={duplicateTemplate}
      />
    </div>
  );
}
