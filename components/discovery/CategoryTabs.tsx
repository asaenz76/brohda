import Link from "next/link";
import type { DiscoveryCategory } from "@/lib/prediction-markets/discovery/types";

// Renders entirely from configured category data (roadmap STEP 13) — no
// hard-coded category list anywhere in this file. Disabled categories are
// never passed in (the page only fetches enabled ones), so they simply
// cannot appear here without any conditional logic needed. Plain links
// (not buttons/JS tabs) — keyboard- and screen-reader-accessible by
// default, no custom ARIA tab pattern required for something this simple.

export function CategoryTabs({ categories, activeSlug }: { categories: DiscoveryCategory[]; activeSlug: string | null }) {
  return (
    <nav aria-label="Discovery categories" className="flex gap-2 overflow-x-auto pb-1">
      <CategoryTabLink href="/markets" label="All" active={activeSlug === null} />
      {categories.map((category) => (
        <CategoryTabLink key={category.id} href={`/markets?category=${category.slug}`} label={category.displayName} active={activeSlug === category.slug} />
      ))}
    </nav>
  );
}

function CategoryTabLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-accent-primary text-white" : "bg-surface-secondary text-text-secondary hover:text-text-primary"
      }`}
    >
      {label}
    </Link>
  );
}
