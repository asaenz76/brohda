import Link from "next/link";
import { Search as SearchIcon } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Avatar } from "@/components/Avatar";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { LocalDateTime } from "@/components/LocalDateTime";
import { SearchInput } from "./search-input";

type SearchProfile = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
};

type SearchFixture = {
  id: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  scheduledStartUtc: string;
};

const FIXTURE_SELECT = "id, home_team_name, away_team_name, competition_name, scheduled_start_utc";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";

  await requireUser();
  const supabase = await createClient();

  let results: SearchProfile[] = [];
  let fixtures: SearchFixture[] = [];
  if (query.length > 0) {
    // Separate .ilike() queries, merged in JS, rather than a single .or()
    // filter string — .or() takes a raw PostgREST filter expression built
    // by string interpolation, so untrusted input could inject extra
    // filter clauses via its comma/paren syntax. .ilike()'s pattern
    // argument is passed as a normal bound value, no such risk.
    const pattern = `%${query}%`;
    const [{ data: byName }, { data: byUsername }, { data: byHomeTeam }, { data: byAwayTeam }, { data: byCompetition }] =
      await Promise.all([
        supabase.from("public_profiles").select("*").ilike("display_name", pattern).limit(20),
        supabase.from("public_profiles").select("*").ilike("username", pattern).limit(20),
        supabase.from("fixtures").select(FIXTURE_SELECT).ilike("home_team_name", pattern).limit(20),
        supabase.from("fixtures").select(FIXTURE_SELECT).ilike("away_team_name", pattern).limit(20),
        supabase.from("fixtures").select(FIXTURE_SELECT).ilike("competition_name", pattern).limit(20),
      ]);

    const merged = new Map<string, SearchProfile>();
    for (const profile of [...(byName ?? []), ...(byUsername ?? [])]) {
      merged.set(profile.id, profile);
    }
    results = [...merged.values()].slice(0, 30);

    const mergedFixtures = new Map<
      string,
      {
        id: string;
        home_team_name: string;
        away_team_name: string;
        competition_name: string | null;
        scheduled_start_utc: string;
      }
    >();
    for (const fixture of [...(byHomeTeam ?? []), ...(byAwayTeam ?? []), ...(byCompetition ?? [])]) {
      mergedFixtures.set(fixture.id, fixture);
    }

    // Only surface fixtures that actually have a pool to enter — landing on
    // an empty fixture page from a search result would be a dead end.
    const fixtureIds = [...mergedFixtures.keys()];
    const { data: poolsForFixtures } =
      fixtureIds.length > 0
        ? await supabase.from("pools").select("fixture_id").in("fixture_id", fixtureIds)
        : { data: [] as { fixture_id: string | null }[] };
    const fixtureIdsWithPools = new Set((poolsForFixtures ?? []).map((p) => p.fixture_id));

    fixtures = [...mergedFixtures.values()]
      .filter((f) => fixtureIdsWithPools.has(f.id))
      .slice(0, 20)
      .map((f) => ({
        id: f.id,
        homeTeamName: f.home_team_name,
        awayTeamName: f.away_team_name,
        competitionName: f.competition_name,
        scheduledStartUtc: f.scheduled_start_utc,
      }));
  }

  const hasResults = results.length > 0 || fixtures.length > 0;

  return (
    <div className="space-y-[18px] sm:space-y-[22px]">
      <h1 className="sr-only">Search</h1>
      <SearchInput initialQuery={query} />

      {query.length === 0 ? (
        <EmptyFeedState
          icon={SearchIcon}
          title="Search for players or fixtures"
          description="Find people by name or username, or a match by team or league."
        />
      ) : !hasResults ? (
        <EmptyFeedState
          icon={SearchIcon}
          title="No results"
          description={`Nothing matches "${query}".`}
        />
      ) : (
        <div className="space-y-6">
          {results.length > 0 && (
            <section className="space-y-1">
              <h2 className="px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                Players
              </h2>
              <ul className="space-y-1">
                {results.map((profile) => {
                  const row = (
                    <div className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-surface-secondary">
                      <Avatar displayName={profile.display_name} avatarUrl={profile.avatar_url} size="md" />
                      <div>
                        <p className="text-sm font-medium text-text-primary">{profile.display_name}</p>
                        {profile.username && (
                          <p className="text-xs text-text-muted">@{profile.username}</p>
                        )}
                      </div>
                    </div>
                  );

                  return (
                    <li key={profile.id}>
                      {/* Not every user has set a username — the profile
                          route accepts an id as a fallback so a result is
                          always clickable. */}
                      <Link href={`/profile/${profile.username ?? profile.id}`}>{row}</Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {fixtures.length > 0 && (
            <section className="space-y-1">
              <h2 className="px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                Fixtures
              </h2>
              <ul className="space-y-1">
                {fixtures.map((fixture) => (
                  <li key={fixture.id}>
                    <Link
                      href={`/fixture/${fixture.id}`}
                      className="flex flex-col rounded-xl px-3 py-2 hover:bg-surface-secondary"
                    >
                      <span className="text-sm font-medium text-text-primary">
                        {fixture.homeTeamName} vs {fixture.awayTeamName}
                      </span>
                      <span className="text-xs text-text-muted">
                        {fixture.competitionName ? `${fixture.competitionName} · ` : ""}
                        <LocalDateTime
                          iso={fixture.scheduledStartUtc}
                          options={{ month: "short", day: "numeric" }}
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
