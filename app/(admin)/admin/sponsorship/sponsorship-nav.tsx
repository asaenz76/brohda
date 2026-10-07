import Link from "next/link";

const LINKS = [
  { href: "/admin/sponsorship", label: "Review queue" },
  { href: "/admin/sponsorship/inventory", label: "Inventory" },
  { href: "/admin/sponsorship/sponsors", label: "Sponsors" },
];

export function SponsorshipNav({ active }: { active: string }) {
  return (
    <nav aria-label="Sponsorship" className="flex flex-wrap gap-2 text-sm">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.href === active ? "page" : undefined} className={l.href === active ? "rounded-md bg-secondary px-3 py-1.5 font-medium text-text-primary" : "rounded-md px-3 py-1.5 text-text-muted hover:text-text-secondary"}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
