import Link from "next/link";
import { cn } from "@/lib/utils";

// The footer every page ends with, signed in or out: the Rules, the Terms,
// the Privacy policy, the public Sponsorship page and the copyright line. It lives at the very
// bottom of the page (below the feed), not in a sidebar, so it is the same
// place on every screen size. The routes sit next to each other at the
// top level (app/rules, app/terms, app/privacy, app/sponsorship) and need no account.
// Sponsor Terms are deliberately NOT here: they are linked from the Sponsorship page, Sponsor signup and the Sponsor area.
export const FOOTER_LINKS = [
  { label: "Rules", href: "/rules" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
  { label: "Sponsorship", href: "/sponsorship" },
] as const;

export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t border-border-subtle pt-4", className)}>
      <nav aria-label="About and legal" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        {FOOTER_LINKS.map(({ label, href }) => (
          <Link key={href} href={href} className="underline-offset-4 hover:text-text-primary hover:underline">
            {label}
          </Link>
        ))}
        <span>© {new Date().getFullYear()} Brohda</span>
      </nav>
    </footer>
  );
}
