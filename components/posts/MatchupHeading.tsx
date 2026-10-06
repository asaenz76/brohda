import { TeamCrest } from "@/components/TeamCrest";
import { getMatchupSeparator, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";

/**
 * A Game's two teams with their crests, in the sport's own matchup order and with its own separator ("Away @ Home" for American
 * football, "Home vs Away" for football). The one place a Game header is composed — no component hard-codes an order or a sport.
 * Renders inline content only; the caller supplies the wrapping element and its typography.
 */
export function MatchupHeading({
  sport,
  homeTeamName,
  awayTeamName,
  homeTeamLogoUrl,
  awayTeamLogoUrl,
}: {
  sport: string;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamLogoUrl: string | null;
  awayTeamLogoUrl: string | null;
}) {
  const [first, second] = orderTeamsForDisplay(
    sport,
    { name: homeTeamName, logoUrl: homeTeamLogoUrl },
    { name: awayTeamName, logoUrl: awayTeamLogoUrl },
  );
  return (
    <>
      <TeamCrest logoUrl={first.logoUrl} teamName={first.name} />
      {first.name} {getMatchupSeparator(sport)} <TeamCrest logoUrl={second.logoUrl} teamName={second.name} />
      {second.name}
    </>
  );
}
