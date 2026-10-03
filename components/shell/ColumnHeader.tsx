import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The one compact header every centre column starts with — on the
// logged-out front door and on every signed-in page — so the two read as
// the same product. It sticks to the top while the column scrolls (a
// single sticky layer; on phones the logo bar above it is not sticky).
//
// `children` is an optional second row (the Sports | Leagues | Teams tab
// bar): the tab list draws its own underline, so a header with tabs skips
// its own bottom border rather than doubling it.
export function ColumnHeader({
  title,
  icon: Icon,
  headingLevel = 1,
  backHref,
  backLabel = "Back",
  actions,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  headingLevel?: 1 | 2;
  /** A detail page (a Post) offers a way back to where it came from. */
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <div
      data-slot="column-header"
      className={cn(
        "sticky top-0 z-20 -mx-4 bg-background md:mx-0",
        children ? "md:rounded-t-lg md:border md:border-b-0 md:border-border-subtle" : "border-b border-border-subtle md:rounded-lg md:border",
      )}
    >
      <div className="flex min-h-12 items-center gap-2 px-4 py-2.5">
        {backHref && (
          <Link
            href={backHref}
            aria-label={backLabel}
            className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-md text-text-secondary outline-none hover:bg-surface-secondary hover:text-text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
        )}
        {Icon && !backHref && <Icon className="size-5 shrink-0 text-text-secondary" aria-hidden="true" />}
        <Heading className="min-w-0 flex-1 truncate text-base font-semibold text-text-primary">{title}</Heading>
        {actions}
      </div>
      {children && <div className="px-1">{children}</div>}
    </div>
  );
}
