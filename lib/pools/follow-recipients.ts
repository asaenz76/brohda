import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export interface PoolFollowRecipient {
  userId: string;
  emailEnabled: boolean;
}

/**
 * Resolves who should be notified that a pool was published, based on
 * who follows its fixture's home team, away team, or league — deduped by
 * user so following via more than one path never means more than one
 * notification/email. `emailEnabled` is true if ANY matching follow row
 * has its own email switch on (in-app fires regardless either way; this
 * value only gates the email half of the fan-out).
 *
 * The single choke point both the notification and email fan-out call,
 * so this matching/dedupe logic exists in exactly one place.
 */
export async function getPoolPublishFollowRecipients(
  fixtureId: string | null,
): Promise<PoolFollowRecipient[]> {
  if (!fixtureId) return []; // CUSTOM/COMBO pools have no fixture to match against

  const admin = createAdminClient();

  const { data: fixture } = await admin
    .from("fixtures")
    .select("provider, home_team_external_id, away_team_external_id, competition_external_id")
    .eq("id", fixtureId)
    .single();

  if (!fixture) return [];

  const teamExternalIds = [fixture.home_team_external_id, fixture.away_team_external_id].filter(
    (id): id is string => id != null,
  );

  const [{ data: teams }, { data: league }] = await Promise.all([
    teamExternalIds.length > 0
      ? admin.from("teams").select("id").eq("provider", fixture.provider).in("external_id", teamExternalIds)
      : Promise.resolve({ data: [] as { id: string }[] }),
    fixture.competition_external_id
      ? admin
          .from("leagues")
          .select("id")
          .eq("provider", fixture.provider)
          .eq("external_id", fixture.competition_external_id)
          .maybeSingle()
      : Promise.resolve({ data: null as { id: string } | null }),
  ]);

  const teamIds = (teams ?? []).map((t) => t.id);
  if (teamIds.length === 0 && !league) return [];

  const [{ data: teamFollowers }, { data: leagueFollowers }] = await Promise.all([
    teamIds.length > 0
      ? admin.from("team_follows").select("user_id, email_enabled").in("team_id", teamIds)
      : Promise.resolve({ data: [] as { user_id: string; email_enabled: boolean }[] }),
    league
      ? admin.from("league_follows").select("user_id, email_enabled").eq("league_id", league.id)
      : Promise.resolve({ data: [] as { user_id: string; email_enabled: boolean }[] }),
  ]);

  const emailByUser = new Map<string, boolean>();
  for (const row of [...(teamFollowers ?? []), ...(leagueFollowers ?? [])]) {
    emailByUser.set(row.user_id, (emailByUser.get(row.user_id) ?? false) || row.email_enabled);
  }

  return [...emailByUser.entries()].map(([userId, emailEnabled]) => ({ userId, emailEnabled }));
}
