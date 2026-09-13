import type { PoolVisibility } from "@/lib/pools/card-state";

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Administrative/secondary metadata — visibility and posted time. Never
// shown on a feed/list card (that's exactly the clutter the PoolStatus
// split was meant to remove); only rendered on the pool's own /pool/[id]
// detail page, which is what the "Pool details ›" disclosure link points
// to. Not a live-ticking clock like PoolSummary's countdown — this is a
// one-time "when was this posted" fact, fine to compute once per render.
export function PoolMetadata({ visibility, createdAt }: { visibility: PoolVisibility; createdAt: string }) {
  return (
    <p className="text-xs text-text-muted">
      {visibility === "HIDDEN" ? "Private" : "Public"} · Posted {relativeTime(createdAt)}
    </p>
  );
}
