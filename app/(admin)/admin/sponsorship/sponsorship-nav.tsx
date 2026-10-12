import Link from "next/link";
import { countReviewItems } from "@/lib/sponsorship/repository";
import { reviewTabLabel } from "@/lib/sponsorship/review-policy";

const LINKS = [
  { href: "/admin/sponsorship", label: "Review queue" },
  { href: "/admin/sponsorship/campaigns", label: "Campaigns" },
  { href: "/admin/sponsorship/inventory", label: "Inventory" },
  { href: "/admin/sponsorship/sponsors", label: "Sponsors" },
];

// The Sponsorship admin tabs. The Review queue tab carries the number of objects actually awaiting review (never settings, payment or legal status). Global Sponsorship configuration is
// not rendered here: a small link points to Settings → Brohda, where each setting has exactly one control.
export async function SponsorshipNav({ active }: { active: string }) {
  const counts = await countReviewItems().catch(() => null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <nav aria-label="Sponsorship" className="flex flex-wrap gap-2 text-sm">
        {LINKS.map((l) => {
          const label = l.href === "/admin/sponsorship" && counts ? reviewTabLabel(counts.total) : l.label;
          return (
            <Link key={l.href} href={l.href} aria-current={l.href === active ? "page" : undefined} className={l.href === active ? "rounded-md bg-secondary px-3 py-1.5 font-medium text-text-primary" : "rounded-md px-3 py-1.5 text-text-secondary hover:bg-secondary"}>
              {label}
            </Link>
          );
        })}
      </nav>
      <Link href="/admin/settings/brohda#sponsorship" className="text-xs text-text-muted hover:text-text-primary hover:underline" data-slot="sponsorship-settings-link">
        Sponsorship settings
      </Link>
    </div>
  );
}
