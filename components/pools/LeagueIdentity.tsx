import type { PoolType } from "@/lib/pools/templates";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import { LeagueFollowToggle } from "@/components/pools/LeagueFollowToggle";

interface LeagueIdentityProps {
  competitionName: string | null;
  competitionCountry: string | null;
  competitionLogoUrl: string | null;
  poolType: PoolType;
  // Null whenever there's no viewer to follow as (logged-out landing
  // preview), the league hasn't been backfilled into `leagues` yet, or the
  // pool has no competition at all (CUSTOM/COMBO).
  leagueFollow?: SocialPoolCardViewModel["fixture"]["leagueFollow"];
}

// Every pool is admin-created, so a creator identity (who posted it) isn't
// meaningful the way it would be for user-generated content — every pool
// has the same "author". The league/competition is what actually
// distinguishes one pool from another, so that's the card's identity row.
// CUSTOM pools have no fixture/competition at all (see lib/pools/fetch.ts's
// synthesized fixture stand-in), hence the fallback label. No-logo fallback
// matches TeamIdentity's own badge — a plain circle, not initials. COMBO
// pools get the brand mark instead of that grey placeholder — a combo spans
// multiple legs/fixtures, so there's never a single competition logo to
// show, but "no logo at all" reads as broken rather than intentional.
export function LeagueIdentity({
  competitionName,
  competitionCountry,
  competitionLogoUrl,
  poolType,
  leagueFollow = null,
}: LeagueIdentityProps) {
  const label = competitionName
    ? competitionCountry
      ? `${competitionCountry} | ${competitionName}`
      : competitionName
    : poolType === "COMBO"
      ? "Combo"
      : "Custom Poll";

  return (
    <div className="flex items-center gap-2">
      {poolType === "COMBO" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/logo-combo.svg" alt="" className="size-8 rounded-full object-contain" />
      ) : competitionLogoUrl ? (
        // External provider logos (arbitrary CDN domains) — plain <img>
        // rather than next/image, same reasoning as TeamIdentity's badges
        // (no remote-domain whitelist to maintain per provider).
        // eslint-disable-next-line @next/next/no-img-element
        <img src={competitionLogoUrl} alt="" className="size-8 rounded-full object-contain" />
      ) : (
        <span className="size-8 rounded-full bg-surface-elevated" aria-hidden="true" />
      )}
      <p className="text-sm font-semibold text-text-primary">{label}</p>
      {leagueFollow && (
        <LeagueFollowToggle
          leagueId={leagueFollow.id}
          leagueName={competitionName ?? label}
          initiallyFollowing={leagueFollow.following}
        />
      )}
    </div>
  );
}
