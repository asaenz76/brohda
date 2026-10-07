import { TeamCrest } from "@/components/TeamCrest";
import { SportIcon } from "@/components/identity/SportIcon";
import { cn } from "@/lib/utils";

/**
 * The one visual mark for a Community: the team's or league's crest when the provider supplied one, and for a SPORT Community (which has no crest)
 * the sport's own icon in a soft round chip, so every Community row has a mark and sports no longer look plainer than teams and leagues. `className`
 * is the size (e.g. `size-8`), exactly as TeamCrest takes it. A team or league without a logo still renders nothing, as before.
 */
export function CommunityMark({ logoUrl, name, sportKey, className }: { logoUrl: string | null; name: string; sportKey?: string | null; className?: string }) {
  if (logoUrl) return <TeamCrest logoUrl={logoUrl} teamName={name} className={className} />;
  if (!sportKey) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-surface-secondary text-text-primary", className ?? "size-5")}>
      {/* sized as a share of the chip itself (a percentage PADDING would resolve against the parent's width, not the chip's) */}
      <SportIcon sport={sportKey} className="size-[66%]" />
    </span>
  );
}
