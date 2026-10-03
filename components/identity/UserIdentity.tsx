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

const AVATAR_SIZE: Record<"sm" | "md" | "lg", "sm" | "md" | "lg"> = { sm: "sm", md: "md", lg: "lg" };

/**
 * Full treatment: avatar, display name, @handle, reputation on its own
 * line. For a Post/Comment author header, a profile page, or anywhere
 * identity is the primary content. `size="lg"` (Phase F addition — a
 * Profile header is the one context prominent enough to warrant a bigger
 * avatar than a comment byline or feed card ever needs) scales the avatar
 * and name text up a step; reputation/handle stay the same size at every
 * size, since they're secondary to the name at any scale.
 */
export function UserIdentity({ displayName, username, avatarUrl, reputation, href, size = "md", wrapReputation = false, className }: UserIdentityBaseProps & { size?: "sm" | "md" | "lg"; wrapReputation?: boolean }) {
  const rep = reputation ? formatReputation(reputation) : null;
  const body = (
    // min-w-0 here (not just on the inner flex-col below) is load-bearing:
    // this div is itself a flex ITEM wherever a caller places it inside
    // another flex row (e.g. ProfileHeader's identity+action row) — a flex
    // item's default min-width is `auto`, which silently overrides any
    // descendant `truncate` and lets a long display name overflow the row
    // instead of actually shrinking. Found via a real long-display-name
    // E2E check against the Phase F Profile header, not a hypothetical.
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <Avatar displayName={displayName} avatarUrl={avatarUrl} size={AVATAR_SIZE[size]} />
      <div className="flex min-w-0 flex-col">
        <span className={cn("truncate font-semibold text-text-primary", size === "lg" ? "text-base" : "text-sm")}>{displayName}</span>
        {username && <span className="truncate text-xs text-text-muted">@{username}</span>}
        {rep && <span className={cn("text-xs text-text-muted", !wrapReputation && "truncate")}>{fullReputationLabel(rep)}</span>}
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

/**
 * Compact treatment: a small avatar plus a single inline text line —
 * "André · 67% · 42 predicted". For a comment-thread byline or any dense
 * list row where the full stacked UserIdentity block is too heavy.
 *
 * Phase G addition: `avatarUrl` (required, matching the full UserIdentity
 * above — `null` is a normal, handled value, rendering Avatar's own
 * initials fallback). The original Phase B version of this component had
 * no avatar slot at all; it had zero real callers anywhere in the app
 * until this phase's Post conversation redesign needed exactly this
 * shape (name + compact reputation, but WITH an avatar — unlike the
 * avatar-less original), so the prop was added rather than inventing a
 * third, parallel compact variant.
 */
export function CompactUserIdentity({ displayName, avatarUrl, reputation, href, className }: Omit<UserIdentityBaseProps, "username">) {
  const rep = reputation ? formatReputation(reputation) : null;
  const body = (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Avatar displayName={displayName} avatarUrl={avatarUrl} size="sm" />
      <span className="text-sm text-text-primary">
        <span className="font-semibold">{displayName}</span>
        {rep && <span className="text-text-muted"> · {compactReputationLabel(rep)}</span>}
      </span>
    </span>
  );
  return href ? (
    <Link href={href} className="inline-flex rounded-sm outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}
