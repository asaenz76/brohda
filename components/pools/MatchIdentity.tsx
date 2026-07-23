import { cn } from "@/lib/utils";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";

function TeamBadge({
  name,
  logoUrl,
  align = "left",
}: {
  name: string;
  logoUrl: string | null;
  align?: "left" | "right";
}) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center gap-2",
        align === "right" && "flex-row-reverse text-right",
      )}
    >
      {logoUrl ? (
        // External provider logos (arbitrary CDN domains) — plain <img>
        // rather than next/image to avoid maintaining a remote-domain
        // whitelist for every possible sports-data provider.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-7 rounded-full object-contain" />
      ) : (
        <span className="size-7 rounded-full bg-surface-elevated" aria-hidden="true" />
      )}
      <span className="text-sm font-semibold text-text-primary">{name}</span>
    </div>
  );
}

export function MatchIdentity({ fixture }: { fixture: SocialPoolCardViewModel["fixture"] }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <TeamBadge name={fixture.homeTeamName} logoUrl={fixture.homeTeamLogoUrl} />
        <span className="text-xs font-semibold text-text-muted">VS</span>
        <TeamBadge name={fixture.awayTeamName} logoUrl={fixture.awayTeamLogoUrl} align="right" />
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
