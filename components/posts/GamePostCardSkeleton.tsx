import { Card, CardContent } from "@/components/ui/card";

// Loading placeholder for GamePostCard, shaped to match its real layout
// (authorship line -> matchup -> status line -> question -> pick buttons ->
// comment footer) so Home doesn't jump or reflow once real content streams in.
// Pure presentation, no props — every field is a fixed-width shimmer block.
export function GamePostCardSkeleton() {
  return (
    <Card>
      <CardContent className="animate-pulse space-y-3 pt-6" aria-hidden="true">
        <div className="h-3 w-28 rounded bg-surface-elevated" />
        <div className="h-5 w-56 rounded bg-surface-elevated" />
        <div className="h-3 w-32 rounded bg-surface-elevated" />
        <div className="space-y-1.5">
          <div className="h-5 w-4/5 rounded bg-surface-elevated" />
        </div>
        <div className="flex gap-2">
          <div className="h-10 flex-1 rounded-lg bg-surface-elevated" />
          <div className="h-10 flex-1 rounded-lg bg-surface-elevated" />
        </div>
        <div className="h-3 w-24 rounded bg-surface-elevated" />
      </CardContent>
    </Card>
  );
}
