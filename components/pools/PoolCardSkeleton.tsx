// Loading placeholder for SocialPoolCard, shaped to match its real layout
// (league header -> match identity -> sentiment bar -> social row ->
// question -> two option buttons -> footer line) so the feed/pool-detail
// route doesn't jump or reflow once real content streams in. Pure
// presentation, no props — every field is a fixed-width shimmer block.
export function PoolCardSkeleton() {
  return (
    <div
      className="animate-pulse space-y-3.5 rounded-2xl border border-border-subtle bg-surface-primary p-5"
      aria-hidden="true"
    >
      <div className="flex items-start gap-3">
        <span className="size-8 shrink-0 rounded-full bg-surface-elevated" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3.5 w-32 rounded bg-surface-elevated" />
          <div className="h-3 w-20 rounded bg-surface-elevated" />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-1 items-center gap-2">
            <span className="size-7 shrink-0 rounded-full bg-surface-elevated" />
            <div className="h-3.5 w-24 rounded bg-surface-elevated" />
          </div>
          <div className="h-3 w-6 shrink-0 rounded bg-surface-elevated" />
          <div className="flex flex-1 items-center justify-end gap-2">
            <div className="h-3.5 w-24 rounded bg-surface-elevated" />
            <span className="size-7 shrink-0 rounded-full bg-surface-elevated" />
          </div>
        </div>
        <div className="mx-auto h-3 w-40 rounded bg-surface-elevated" />
      </div>

      <div className="h-2 w-full rounded-full bg-surface-elevated" />

      <div className="flex items-center gap-3">
        <div className="flex -space-x-2">
          <span className="size-6 rounded-full bg-surface-elevated ring-2 ring-surface-primary" />
          <span className="size-6 rounded-full bg-surface-elevated ring-2 ring-surface-primary" />
          <span className="size-6 rounded-full bg-surface-elevated ring-2 ring-surface-primary" />
        </div>
        <div className="h-3.5 w-20 rounded bg-surface-elevated" />
      </div>

      <div className="space-y-1.5">
        <div className="h-5 w-4/5 rounded bg-surface-elevated" />
        <div className="h-4 w-24 rounded-full bg-surface-elevated" />
      </div>

      <div className="space-y-2">
        <div className="h-11 w-full rounded-xl bg-surface-elevated" />
        <div className="h-11 w-full rounded-xl bg-surface-elevated" />
      </div>

      <div className="h-3 w-52 rounded bg-surface-elevated" />
    </div>
  );
}
