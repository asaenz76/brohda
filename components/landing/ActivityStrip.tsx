import type { LandingActivityItem } from "@/lib/landing/fetch";

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Pill({ item }: { item: LandingActivityItem }) {
  return (
    <span className="shrink-0 rounded-full border border-border-subtle bg-surface-primary px-3 py-1.5 text-xs text-text-secondary">
      {item.text} <span className="text-text-muted">· {relativeTime(item.createdAt)}</span>
    </span>
  );
}

// Real recent picks (already public — see PUBLIC_POOL_FILTERS in
// lib/landing/fetch.ts), not scripted/demo copy — makes the site feel
// active before anyone signs up. Scrolls as a continuous marquee (see
// .animate-marquee in globals.css); the item list is duplicated once so
// the loop has no visible seam, and "LIVE NOW" stays pinned outside the
// scrolling track since it's a label, not an item.
export function ActivityStrip({ items }: { items: LandingActivityItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="overflow-hidden border-y border-border-subtle bg-surface-secondary/60">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-accent-primary">
          <span className="size-1.5 rounded-full bg-accent-primary" aria-hidden="true" />
          LIVE NOW
        </span>
        <div className="flex-1 overflow-hidden">
          <div className="flex w-max animate-marquee gap-2">
            {items.map((item) => (
              <Pill key={`a-${item.id}`} item={item} />
            ))}
            {items.map((item) => (
              <Pill key={`b-${item.id}`} item={item} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
