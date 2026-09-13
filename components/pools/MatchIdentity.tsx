import { LocalDateTime } from "@/components/LocalDateTime";
import { TeamIdentity } from "@/components/pools/TeamIdentity";
import { getMatchupSeparator, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";

// Matches the approved mockup's order — kickoff date/time sits right under
// the question, ahead of the team crests, not tucked underneath them.
export function MatchIdentity({ fixture }: { fixture: SocialPoolCardViewModel["fixture"] }) {
  // Broadcast convention differs by sport: NFL lists away first ("Away @
  // Home"), football/soccer lists home first ("Home vs Away") — see
  // lib/sports-data/team-display-order.ts.
  const home = { name: fixture.homeTeamName, logoUrl: fixture.homeTeamLogoUrl, follow: fixture.homeTeamFollow };
  const away = { name: fixture.awayTeamName, logoUrl: fixture.awayTeamLogoUrl, follow: fixture.awayTeamFollow };
  const [first, second] = orderTeamsForDisplay(fixture.sport, home, away);

  return (
    <div className="space-y-4">
      <p className="text-center text-xs text-text-muted">
        {/* Full date + time + zone abbreviation, personalized to each
            viewer's own local timezone (LocalDateTime) — a Costa-Rica-based
            admin and a player watching from Tokyo each read this fixture's
            kickoff in their own wall-clock time, not the server's. */}
        <LocalDateTime
          iso={fixture.kickoffAt}
          options={{ month: "2-digit", day: "2-digit", year: "numeric" }}
        />{" "}
        ·{" "}
        <LocalDateTime
          iso={fixture.kickoffAt}
          options={{ hour: "numeric", minute: "2-digit", timeZoneName: "short" }}
        />
        {/* competitionName lives in LeagueIdentity now — not repeated here. */}
        {fixture.round ? ` · ${fixture.round}` : ""}
      </p>
      <div className="flex items-center justify-center gap-4 sm:gap-6">
        <TeamIdentity name={first.name} logoUrl={first.logoUrl} follow={first.follow} />
        <span className="shrink-0 text-xs font-semibold text-text-muted">
          {getMatchupSeparator(fixture.sport).toUpperCase()}
        </span>
        <TeamIdentity name={second.name} logoUrl={second.logoUrl} follow={second.follow} />
      </div>
    </div>
  );
}
