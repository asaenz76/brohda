import Link from "next/link";
import { Search as SearchIcon } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { Avatar } from "@/components/Avatar";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { LocalDateTime } from "@/components/LocalDateTime";
import { listPostIdsForFixtures } from "@/lib/predictions/post-links";
import { getMatchupSeparator, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";
import { SearchInput } from "./search-input";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

type SearchProfile = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
};

type SearchFixture = {
  id: string;
  postId: string;
  sport: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  scheduledStartUtc: string;
};

const FIXTURE_SELECT = "id, sport, home_team_name, away_team_name, competition_name, scheduled_start_utc";

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
        sport: string;
        home_team_name: string;
        away_team_name: string;
        competition_name: string | null;
        scheduled_start_utc: string;
      }
    >();
    for (const fixture of [...(byHomeTeam ?? []), ...(byAwayTeam ?? []), ...(byCompetition ?? [])]) {
      mergedFixtures.set(fixture.id, fixture);
    }

    // Only surface fixtures that resolve to a canonical, published Post —
    // the legacy Pool-browsing fixture page is retired (Phase H), and
    // linking to a fixture with nothing to show would be a dead end.
    const postIdByFixtureId = await listPostIdsForFixtures([...mergedFixtures.keys()]);

    fixtures = [...mergedFixtures.values()]
      .filter((f) => postIdByFixtureId.has(f.id))
      .slice(0, 20)
      .map((f) => ({
        id: f.id,
        postId: postIdByFixtureId.get(f.id) as string,
        sport: f.sport,
        homeTeamName: f.home_team_name,
        awayTeamName: f.away_team_name,
        competitionName: f.competition_name,
        scheduledStartUtc: f.scheduled_start_utc,
      }));
  }

  const hasResults = results.length > 0 || fixtures.length > 0;

  return (
    <div className="space-y-3">
      <ColumnHeader title="Search" icon={SearchIcon} />
      <SearchInput initialQuery={query} />

      {query.length === 0 ? (
        <EmptyFeedState
          icon={SearchIcon}
          title="Search for players or games"
          description="Find people by name or username, or a game by team or league."
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
                    <div className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-secondary">
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
                Games
              </h2>
              <ul className="space-y-1">
                {fixtures.map((fixture) => {
                  const [firstTeam, secondTeam] = orderTeamsForDisplay(
                    fixture.sport,
                    fixture.homeTeamName,
                    fixture.awayTeamName,
                  );
                  return (
                    <li key={fixture.id}>
                      <Link
                        href={`/post/${fixture.postId}`}
                        className="flex flex-col rounded-lg px-3 py-2 hover:bg-surface-secondary"
                      >
                        <span className="text-sm font-medium text-text-primary">
                          {firstTeam} {getMatchupSeparator(fixture.sport)} {secondTeam}
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
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
