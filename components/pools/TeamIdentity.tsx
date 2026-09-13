import { TeamFollowToggle } from "@/components/pools/TeamFollowToggle";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";

// Large, centered crest-first identity — the visual anchor of the card
// (matches the approved mockup), not a small inline badge. `record` is
// accepted but not wired to real data yet: no team-season-record field
// exists anywhere in the sports-data layer (confirmed against
// lib/sports-data/types.ts and the view-model) — showing one here would
// mean fabricating it. Left as a prop so a future data source can populate
// it without another layout change.
export function TeamIdentity({
  name,
  logoUrl,
  record,
  follow,
}: {
  name: string;
  logoUrl: string | null;
  record?: string | null;
  follow: SocialPoolCardViewModel["fixture"]["homeTeamFollow"];
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
      {logoUrl ? (
        // External provider logos (arbitrary CDN domains) — plain <img>
        // rather than next/image to avoid maintaining a remote-domain
        // whitelist for every possible sports-data provider. Sized for a
        // real crest image (the approved mockup's visual anchor), not
        // around today's gray-circle fallback.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-16 shrink-0 rounded-full object-contain sm:size-20" />
      ) : (
        <span className="size-16 shrink-0 rounded-full bg-surface-elevated sm:size-20" aria-hidden="true" />
      )}
      <div className="flex max-w-full items-center gap-1">
        <span className="truncate text-base font-bold text-text-primary sm:text-lg">{name}</span>
        {/* Null whenever there's no viewer to follow as (logged-out landing
            preview) or the team hasn't been backfilled into `teams` yet —
            the icon simply doesn't render rather than acting on a missing id. */}
        {follow && <TeamFollowToggle teamId={follow.id} teamName={name} initiallyFollowing={follow.following} />}
      </div>
      {record && <span className="text-xs text-text-muted">{record}</span>}
    </div>
  );
}
