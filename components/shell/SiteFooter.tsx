import Link from "next/link";
import { cn } from "@/lib/utils";

// The footer every page ends with, signed in or out: how Brohda works, the
// Terms, the Privacy policy and the copyright line. It lives at the very
// bottom of the page (below the feed), not in a sidebar, so it is the same
// place on every screen size. The routes sit next to each other at the
// top level (app/how-it-works, app/terms, app/privacy) and need no account.
export const FOOTER_LINKS = [
  { label: "How it works", href: "/how-it-works" },
  { label: "Terms", href: "/terms" },
  { label: "Privacy", href: "/privacy" },
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
