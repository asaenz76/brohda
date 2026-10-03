import Link from "next/link";
import { UserIdentity } from "@/components/identity/UserIdentity";
import { TeamCrest } from "@/components/TeamCrest";
import { getUserPredictionRecord } from "@/lib/reputation/repository";
import { listFollowedCommunitiesForProfile } from "@/lib/communities/profile";
import { getCommunityTypeLabel } from "@/lib/communities/presentation";
import type { UserProfile } from "@/lib/auth/session";

// The signed-in right rail: context, not promotion and not a second
// navigation. Two real modules and a footer — who you are (the canonical
// compact identity and reputation) and what you follow (the Sports, Leagues
// and Teams you already follow, via the same query your Profile uses). If
// there is nothing to show it says so plainly; nothing here is invented.
//
// How many followed items per group the rail lists before pointing at the
// full list on Profile: a presentation size, not product policy.
const RAIL_FOLLOWED_LIMIT = 5;

export async function RightRail({ user, profileHref }: { user: UserProfile; profileHref: string }) {
  const [reputation, groups] = await Promise.all([getUserPredictionRecord(user.id), listFollowedCommunitiesForProfile(user.id, user.id)]);

  return (
    <div className="space-y-5">
      <section aria-label="Your profile" className="rounded-lg border border-border-subtle p-3">
        <UserIdentity displayName={user.display_name} username={user.username} avatarUrl={user.avatar_url} reputation={reputation} href={profileHref} wrapReputation />
      </section>

      <section aria-label="Following" className="space-y-3">
        <h2 className="px-1 text-sm font-semibold text-text-primary">Following</h2>
        {groups.length === 0 ? (
          <p className="px-1 text-sm text-text-muted">
            Nothing followed yet.{" "}
            <Link href="/discovery" className="underline underline-offset-4 hover:text-text-primary">
              Find sports, leagues and teams
            </Link>
            .
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.type} className="space-y-1">
              <p className="px-1 text-xs font-medium uppercase tracking-wide text-text-muted">{getCommunityTypeLabel(group.type)}s</p>
              <ul>
                {group.items.slice(0, RAIL_FOLLOWED_LIMIT).map((item) => (
                  <li key={item.id}>
                    <Link href={`/community/${item.slug}`} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1.5 text-sm text-text-secondary outline-none hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-3 focus-visible:ring-ring/50">
                      <TeamCrest logoUrl={item.logoUrl} teamName={item.displayName} className="size-5" />
                      <span className="min-w-0 truncate">{item.displayName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              {group.items.length > RAIL_FOLLOWED_LIMIT && (
                <Link href="/profile?tab=communities" className="block px-1 text-xs text-text-muted underline underline-offset-4 hover:text-text-primary">
                  See all {group.items.length}
                </Link>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
