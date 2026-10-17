import { Suspense } from "react";
import Link from "next/link";
import { LeftNav } from "@/components/shell/LeftNav";
import { MobileNav } from "@/components/shell/MobileNav";
import { RightRail } from "@/components/shell/RightRail";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { InAppHistoryTracker } from "@/components/shell/InAppHistoryTracker";
import { NotificationToast } from "@/components/NotificationToast";
import { ConfidenceSummary } from "@/components/confidence/ConfidenceBalance";
import type { ShellConfidence } from "@/lib/confidence/service";
import { isAdminOrAbove } from "@/lib/auth/guards";
import type { UserProfile } from "@/lib/auth/session";

// The signed-in app's shell — the logged-out front door's own shape with
// your identity, navigation and participation available (no acquisition
// chrome, no change of visual identity):
//
//   < md   one column. A logo-only top bar, the Confidence summary, the page, and a fixed bottom
//          bar (Home, Discovery, Notifications, Profile, Menu).
//   md–xl  left navigation rail + the page.
//   xl+    left rail + the page + a contextual right rail.
//
// Pages render a ColumnHeader and their content into `children`; the shell
// never knows which page it is hosting. The admin section keeps AppShell.
export function AuthenticatedShell({
  user,
  unreadNotificationCount,
  showSocialNav,
  showWallet,
  showMessages = false,
  unreadMessageCount = 0,
  confidence = null,
  children,
}: {
  user: UserProfile;
  unreadNotificationCount: number;
  showSocialNav: boolean;
  /** A plain Wallet link (no balance) is shown only for a Member who still has money in the system — the consumer money capability's wind-down case. */
  showWallet: boolean;
  /** Messaging is ON: show the Messages entry, with the unread count. (A UX signal; each /messages page enforces its own access.) */
  showMessages?: boolean;
  unreadMessageCount?: number;
  /** The Member's Confidence for the shell summary; null while Confidence is off or for anyone without an account (nothing is shown, no space is left). */
  confidence?: ShellConfidence | null;
  children: React.ReactNode;
}) {
  // The viewer's own profile segment: the same one ProfilePage uses for its follower links.
  const profileSlug = user.username ?? user.id;
  const isAdmin = isAdminOrAbove(user);
  const navProps = { profileSlug, showSocialNav, showWallet, unreadNotificationCount, showMessages, unreadMessageCount, isAdmin, confidence };

  return (
    <div className="min-h-full bg-background">
      <header className="border-b border-border-subtle md:hidden">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-4 py-2.5">
          <Link href="/feed" className="font-logo text-lg font-extrabold italic text-text-primary">
            brohda.
          </Link>
        </div>
      </header>

      {/* Phone: the whole Confidence summary (title, total, available, reserved) is the first thing on every page, readable without opening the Menu. On larger screens it lives in the navigation rail instead. */}
      {confidence && (
        <div className="mx-auto max-w-[1200px] px-4 pt-3 md:hidden">
          <ConfidenceSummary {...confidence} variant="banner" />
        </div>
      )}

      <div className="mx-auto grid w-full max-w-[1200px] gap-6 px-4 pt-3 md:grid-cols-[200px_minmax(0,1fr)] md:pt-4 lg:grid-cols-[250px_minmax(0,600px)] lg:justify-center lg:pt-6 xl:grid-cols-[250px_minmax(0,600px)_280px]">
        <aside aria-label="Navigation" className="hidden space-y-6 md:sticky md:top-4 md:block md:self-start lg:top-6">
          <Link href="/feed" className="block px-3 pt-1 font-logo text-[1.7rem] font-extrabold italic leading-none text-text-primary">
            brohda.
          </Link>
          <LeftNav {...navProps} />
        </aside>

        <main id="main" className="min-w-0">
          {children}
        </main>

        <aside aria-label="Context" className="hidden xl:sticky xl:top-6 xl:block xl:self-start">
          <Suspense fallback={null}>
            <RightRail user={user} profileHref={`/profile/${profileSlug}`} />
          </Suspense>
        </aside>
      </div>

      {/* The page's last element; on phones it clears the fixed bottom bar. */}
      <div className="mx-auto mt-6 w-full max-w-[1200px] px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:mt-8 md:pb-8">
        <SiteFooter />
      </div>

      <MobileNav {...navProps} profile={{ displayName: user.display_name, avatarUrl: user.avatar_url }} />
      <InAppHistoryTracker />
      <NotificationToast initialUnreadCount={unreadNotificationCount} />
    </div>
  );
}
