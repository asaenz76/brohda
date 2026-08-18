import { cn } from "@/lib/utils";
import { LocalDateTime } from "@/components/LocalDateTime";
import { TeamFollowToggle } from "@/components/pools/TeamFollowToggle";
import { getMatchupSeparator, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";

function TeamBadge({
  name,
  logoUrl,
  align = "left",
  follow,
}: {
  name: string;
  logoUrl: string | null;
  align?: "left" | "right";
  follow: SocialPoolCardViewModel["fixture"]["homeTeamFollow"];
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2",
        align === "right" && "flex-row-reverse text-right",
      )}
    >
      {/* Fixed px size, not the rem-based `size-7` utility — at large
          accessibility text sizes a rem-based logo would double right
          alongside the text, leaving almost no room for the name itself
          in an already-tight card. Logos staying visually fixed while
          text scales is the standard pattern for exactly this case. */}
      {logoUrl ? (
        // External provider logos (arbitrary CDN domains) — plain <img>
        // rather than next/image to avoid maintaining a remote-domain
        // whitelist for every possible sports-data provider.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-[28px] shrink-0 rounded-full object-contain" />
      ) : (
        <span className="size-[28px] shrink-0 rounded-full bg-surface-elevated" aria-hidden="true" />
      )}
      {/* min-w-0 above lets this shrink below its content's natural width —
          flex items default to min-width:auto, so a long team name would
          otherwise push the whole row wider instead of truncating (real
          failure caught testing at 200% accessibility text size). */}
      <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
      {/* Null whenever there's no viewer to follow as (logged-out landing
          preview) or the team hasn't been backfilled into `teams` yet —
          the icon simply doesn't render rather than acting on a missing id. */}
      {follow && <TeamFollowToggle teamId={follow.id} teamName={name} initiallyFollowing={follow.following} />}
    </div>
  );
}

export function MatchIdentity({ fixture }: { fixture: SocialPoolCardViewModel["fixture"] }) {
  // Broadcast convention differs by sport: NFL lists away first ("Away @
  // Home"), football/soccer lists home first ("Home vs Away") — see
  // lib/sports-data/team-display-order.ts.
  const home = { name: fixture.homeTeamName, logoUrl: fixture.homeTeamLogoUrl, follow: fixture.homeTeamFollow };
  const away = { name: fixture.awayTeamName, logoUrl: fixture.awayTeamLogoUrl, follow: fixture.awayTeamFollow };
  const [first, second] = orderTeamsForDisplay(fixture.sport, home, away);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <TeamBadge name={first.name} logoUrl={first.logoUrl} follow={first.follow} />
        <span className="text-xs font-semibold text-text-muted">
          {getMatchupSeparator(fixture.sport).toUpperCase()}
        </span>
        <TeamBadge name={second.name} logoUrl={second.logoUrl} align="right" follow={second.follow} />
      </div>
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
        {/* competitionName lives in PoolLeagueHeader now — not repeated here. */}
        {fixture.round ? ` · ${fixture.round}` : ""}
      </p>
    </div>
  );
}
