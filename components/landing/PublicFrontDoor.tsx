import Link from "next/link";
import { Search, TrendingUp } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { GamePostCard } from "@/components/posts/GamePostCard";
import { DiscoveryTabNav } from "@/components/discovery/DiscoveryTabNav";
import { PublicCommunityRow } from "@/components/discovery/PublicCommunityRow";
import { PublicMobileMenu } from "@/components/landing/PublicMobileMenu";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { cn } from "@/lib/utils";
import { DISCOVERY_EMPTY_COPY, type DiscoveryTab } from "@/lib/communities/discovery-tabs";
import type { FeedItem } from "@/lib/communities/feed";
import type { CommunityListItem } from "@/lib/communities/discovery";

// The logged-out version of Brohda itself, not a page ABOUT Brohda: a
// Mastodon-shaped shell whose centre column is the product — "Upcoming
// games" with the same Sports | Leagues | Teams tabs Discovery uses, then
// the real platform-published Game Posts (or, on Leagues/Teams, the real
// Community lists). There is no hero, no feature grid, no "how it works",
// no stats and no composer, and nothing here markets the money layer.
//
// Brand copy that is genuinely invariant lives here as constants.
// Everything social comes from real data; nothing on this page is invented.
//
// Responsive model (Mastodon's own pattern):
//   < md   The centre column IS the page. A minimal logo header on top, a
//          fixed bottom bar — [Create account] [Log in] … [☰] — below. The
//          side columns are not rendered; their content lives in the
//          hamburger sheet.
//   md–lg  Centre + a right-hand account column (with the legal links the
//          absent left column would hold).
//   lg+    Left (search, about, legal) / centre / right (brand + the two
//          ways in).

const HEADLINE = "Sports opinions should have a record.";
const TAGLINE = "Pick a side. Talk shit. Call BS. See who was right.";
const ABOUT = "Brohda is a social network for people who think they know sports.";

function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("font-logo font-extrabold italic text-text-primary", className)}>
      brohda.
    </Link>
  );
}

export function PublicFrontDoor({
  tab,
  feed,
  communities,
}: {
  tab: DiscoveryTab;
  feed: FeedItem[];
  communities: CommunityListItem[];
}) {
  return (
    <div className="min-h-full bg-background">
      {/* Below lg there is no brand column, so the wordmark lives in a slim top bar. */}
      <header className="border-b border-border-subtle lg:hidden">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-4 py-2.5">
          <Wordmark className="text-lg" />
          {/* Search needs an account today, so this is honestly a link to log in, not a box that pretends to search. */}
          <Link
            href="/login"
            aria-label="Search (log in to search)"
            title="Log in to search"
            className="hidden size-9 items-center justify-center rounded-full text-text-secondary hover:text-text-primary md:flex"
          >
            <Search className="size-5" aria-hidden="true" />
          </Link>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1200px] gap-6 px-4 pt-3 md:grid-cols-[minmax(0,1fr)_260px] md:pt-4 lg:grid-cols-[250px_minmax(0,600px)_280px] lg:justify-center lg:pt-6">
        {/* LEFT — lightweight context (lg+). Deliberately not a nav: the centre tabs are the way to browse. */}
        <aside aria-label="About Brohda" className="hidden space-y-5 lg:sticky lg:top-6 lg:block lg:self-start">
          <Link
            href="/login"
            className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2.5 text-sm text-text-muted hover:text-text-primary"
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <span>
              Search<span className="sr-only"> players, teams, or users (log in to search)</span>
            </span>
          </Link>
          <p className="text-sm text-text-secondary">{ABOUT}</p>
        </aside>

        {/* CENTRE — the product. */}
        <main id="main" className="min-w-0 space-y-3">
          {/* Narrow screens have no brand column (and so no visible headline); keep a single h1 for assistive tech. */}
          <h1 className="sr-only md:hidden">{HEADLINE}</h1>

          {/* The same sticky column header the signed-in app uses: the title and the three tabs stay in reach while the feed scrolls. */}
          <ColumnHeader title="Upcoming games" icon={TrendingUp} headingLevel={2}>
            <DiscoveryTabNav active={tab} basePath="/" />
          </ColumnHeader>

          {tab === "sports" ? (
            feed.length === 0 ? (
              <p className="rounded-lg border border-border-subtle px-4 py-6 text-sm text-text-muted">
                No games are on the board right now. New games show up here as soon as they&apos;re published.
              </p>
            ) : (
              feed.map((item) => <GamePostCard key={item.post.id} item={item} mode="public" />)
            )
          ) : communities.length === 0 ? (
            <p className="rounded-lg border border-border-subtle px-4 py-6 text-sm text-text-muted">{DISCOVERY_EMPTY_COPY[tab]}</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
              {communities.map((item) => (
                <PublicCommunityRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </main>

        {/* RIGHT — who we are and the two ways in (md+). */}
        <aside aria-label="Join Brohda" className="hidden space-y-4 md:sticky md:top-6 md:block md:self-start">
          <Wordmark className="hidden text-4xl lg:block" />
          <div className="space-y-2">
            <h1 className="text-balance text-2xl font-bold leading-tight tracking-tight text-text-primary">{HEADLINE}</h1>
            <p className="text-sm text-text-secondary">{TAGLINE}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Link href="/register" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
              Create account
            </Link>
            <Link href="/login" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "w-full")}>
              Log in
            </Link>
          </div>
          {/* The left column's content, for the widths where that column isn't shown. */}
          <p className="border-t border-border-subtle pt-4 text-sm text-text-secondary lg:hidden">{ABOUT}</p>
        </aside>
      </div>

      {/* The page's last element, signed in or out; on phones it clears the fixed bar below. */}
      <div className="mx-auto mt-6 w-full max-w-[1200px] px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:mt-8 md:pb-8">
        <SiteFooter />
      </div>

      {/* Mobile: account actions are always on screen; everything else is behind the hamburger. */}
      <div
        data-testid="public-bottom-bar"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-background/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden"
      >
        <div className="mx-auto flex max-w-[480px] items-center gap-2">
          <Link href="/register" className={cn(buttonVariants({ size: "lg" }), "shrink-0")}>
            Create account
          </Link>
          <Link href="/login" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "shrink-0")}>
            Log in
          </Link>
          <PublicMobileMenu about={ABOUT} className="ml-auto" />
        </div>
      </div>
    </div>
  );
}
