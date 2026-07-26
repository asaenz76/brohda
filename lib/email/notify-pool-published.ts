import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPoolPublishedEmail, sendEmail, type PoolPublishedEmailFixture } from "./resend";

// Fires when an admin publishes a pool (DRAFT -> OPEN). Emails every
// active player who hasn't opted out — never admins/super_admins (they
// coordinate pools, they don't enter them), and never for a HIDDEN
// (link-only) pool, since blasting an invite-only pool to everyone would
// defeat the point of hiding it.
export async function notifyPoolPublished(pool: {
  id: string;
  question: string;
  visibility: string;
}): Promise<void> {
  if (pool.visibility !== "VISIBLE_TO_ALL_MEMBERS") return;
  if (!process.env.RESEND_API_KEY) return;

  const admin = createAdminClient();

  const { data: recipients } = await admin
    .from("user_profiles")
    .select("id")
    .eq("role", "player")
    .eq("is_active", true)
    .eq("email_notifications_enabled", true);

  if (!recipients || recipients.length === 0) return;

  const recipientIds = new Set(recipients.map((r) => r.id as string));

  // auth.admin.listUsers() is the only way to read email addresses from
  // this client — it returns every user, not just the ids we asked for,
  // so the filtering happens here rather than in the query above.
  const { data: userList } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const emails = (userList?.users ?? [])
    .filter((u) => recipientIds.has(u.id) && u.email)
    .map((u) => u.email as string);

  if (emails.length === 0) return;

  // The rest of the pool card content (fixture identity, options, lock time)
  // is fetched here rather than widening every call site's argument list,
  // since this notifier is the only place that needs it.
  const { data: poolRow } = await admin
    .from("pools")
    .select("locks_at, fixture_id")
    .eq("id", pool.id)
    .single();

  const { data: optionRows } = await admin
    .from("pool_options")
    .select("label, team_name, logo_url, sort_order")
    .eq("pool_id", pool.id)
    .order("sort_order");

  let fixture: PoolPublishedEmailFixture | null = null;
  if (poolRow?.fixture_id) {
    const { data: fixtureRow } = await admin
      .from("fixtures")
      .select(
        "home_team_name, away_team_name, home_team_logo_url, away_team_logo_url, competition_name, competition_logo_url, scheduled_start_utc",
      )
      .eq("id", poolRow.fixture_id as string)
      .single();

    if (fixtureRow) {
      fixture = {
        homeTeamName: fixtureRow.home_team_name as string,
        awayTeamName: fixtureRow.away_team_name as string,
        homeTeamLogoUrl: fixtureRow.home_team_logo_url as string | null,
        awayTeamLogoUrl: fixtureRow.away_team_logo_url as string | null,
        competitionName: fixtureRow.competition_name as string | null,
        competitionLogoUrl: fixtureRow.competition_logo_url as string | null,
        scheduledStartUtc: fixtureRow.scheduled_start_utc as string,
      };
    }
  }

  const poolUrl = `${process.env.APP_URL}/pool/${pool.id}`;
  const { subject, html } = buildPoolPublishedEmail({
    question: pool.question,
    poolUrl,
    locksAt: (poolRow?.locks_at as string | undefined) ?? new Date().toISOString(),
    options: (optionRows ?? []).map((option) => ({
      label: option.label as string,
      teamName: option.team_name as string | null,
      logoUrl: option.logo_url as string | null,
    })),
    fixture,
  });

  await Promise.all(emails.map((to) => sendEmail({ to, subject, html })));
}
