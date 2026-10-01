import { TeamCrest } from "@/components/TeamCrest";
import { cn } from "@/lib/utils";

// Phase B (design-system redesign) — a reusable presentation wrapper
// around the existing TeamCrest (behavior unchanged; only gained an
// optional `className` for sizing) for the crest+name pairing that will
// recur across Game Posts, Discovery's Teams tab, and Community identity
// once those phases build them. Purely presentational; no Community/
// Discovery data wiring happens here (Phase C/E). TeamCrest already
// degrades gracefully (renders nothing) when `logoUrl` is missing — this
// wrapper doesn't need its own fallback logic, the team name alone still
// reads fine without a crest.
export function TeamIdentity({
  teamName,
  logoUrl,
  size = "sm",
  className,
}: {
  teamName: string;
  logoUrl: string | null;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium text-text-primary", className)}>
      <TeamCrest logoUrl={logoUrl} teamName={teamName} className={size === "md" ? "size-6" : "size-4"} />
      {teamName}
    </span>
  );
}

/**
 * Community identity (Phase E prepares this further) — presentational only.
 * `communityTypeLabel` must always come from the existing
 * `getCommunityTypeLabel()` (lib/communities/presentation.ts), never a raw
 * `CommunityType` enum value, matching the already-completed Stage 4A
 * remediation against exactly that leak.
 */
export function CommunityIdentity({
  name,
  communityTypeLabel,
  logoUrl,
  className,
}: {
  name: string;
  communityTypeLabel: string;
  logoUrl: string | null;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-text-primary", className)}>
      {logoUrl && <TeamCrest logoUrl={logoUrl} teamName={name} className="size-4" />}
      <span className="font-medium">{name}</span>
      <span className="text-xs text-text-muted">{communityTypeLabel}</span>
    </span>
  );
}
