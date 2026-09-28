import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import type { UserPredictionRecord } from "@/lib/reputation/types";

// Phase B (design-system redesign) — the reusable social-identity
// primitive the spec asks for: "André / @asaenz / 67% prediction accuracy
// · 42 predicted" (full) and "André · 67% · 42 predicted" (compact).
// Deliberately PRESENTATIONAL ONLY — no data fetching, no wiring into
// Profile or Comments (that's Phases F/G). Callers pass already-resolved
// data; `reputation` is typed against lib/reputation/types.ts's real
// `UserPredictionRecord` shape (the same one ReputationSummary already
// consumes) so a later phase can plug the real RPC result straight in.
//
// "N predicted" = decided + void, matching ReputationSummary's own
// existing convention — a void Pick still counts as something the user
// predicted, it just never enters the accuracy math (see that type's own
// comment). Locked public terminology: "predicted", never "decided" (spec
// §3/§12) — this file is the one place that formats the count, so no
// caller can accidentally leak the internal word.
export type UserIdentityReputation = Pick<UserPredictionRecord, "accuracy" | "decided" | "void">;

/**
 * `accuracyPercent` is null exactly when `decided === 0` (lib/reputation/
 * types.ts) — still possible even with `predictedCount > 0` if every Pick
 * so far was VOID. Never fabricate a percentage in that case; the two
 * formatted strings below each handle it honestly without guessing.
 */
function formatReputation(reputation: UserIdentityReputation): { accuracyPercent: number | null; predictedCount: number } | null {
  const predictedCount = reputation.decided + reputation.void;
  if (predictedCount === 0) return null;
  const accuracyPercent = reputation.accuracy !== null ? Math.round(reputation.accuracy * 100) : null;
  return { accuracyPercent, predictedCount };
}

function fullReputationLabel(rep: { accuracyPercent: number | null; predictedCount: number }): string {
  const accuracy = rep.accuracyPercent !== null ? `${rep.accuracyPercent}% prediction accuracy` : "no graded predictions yet";
  return `${accuracy} · ${rep.predictedCount} predicted`;
}

function compactReputationLabel(rep: { accuracyPercent: number | null; predictedCount: number }): string {
  const accuracy = rep.accuracyPercent !== null ? `${rep.accuracyPercent}%` : "unranked";
  return `${accuracy} · ${rep.predictedCount} predicted`;
}

interface UserIdentityBaseProps {
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  reputation?: UserIdentityReputation | null;
  /** Wrap the identity block in a link to the user's profile. Omit for a context (e.g. the viewer's own name in a confirmation) where that link doesn't make sense. */
  href?: string;
  className?: string;
}

/** Full treatment: avatar, display name, @handle, reputation on its own line. For a Post/Comment author header, a profile page, or anywhere identity is the primary content. */
export function UserIdentity({ displayName, username, avatarUrl, reputation, href, size = "md", className }: UserIdentityBaseProps & { size?: "sm" | "md" }) {
  const rep = reputation ? formatReputation(reputation) : null;
  const body = (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Avatar displayName={displayName} avatarUrl={avatarUrl} size={size === "sm" ? "sm" : "md"} />
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold text-text-primary">{displayName}</span>
        {username && <span className="truncate text-xs text-text-muted">@{username}</span>}
        {rep && <span className="truncate text-xs text-text-muted">{fullReputationLabel(rep)}</span>}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Compact treatment: no avatar, single inline line — "André · 67% · 42 predicted". For a comment-thread byline or any dense list row where the full block is too heavy. */
export function CompactUserIdentity({ displayName, reputation, href, className }: Omit<UserIdentityBaseProps, "username" | "avatarUrl">) {
  const rep = reputation ? formatReputation(reputation) : null;
  const body = (
    <span className={cn("text-sm text-text-primary", className)}>
      <span className="font-semibold">{displayName}</span>
      {rep && <span className="text-text-muted"> · {compactReputationLabel(rep)}</span>}
    </span>
  );
  return href ? (
    <Link href={href} className="rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}
