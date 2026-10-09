import Link from "next/link";
import { sponsorLogoutAction } from "@/lib/actions/sponsor-account";
import { sponsorAccountStatusCopy } from "@/lib/sponsor/status";
import type { SponsorSession } from "@/lib/sponsor/session";

// The Sponsor's own shell. Deliberately NOT the Member shell: no feed, no wallet, no notifications, no profile of a person — a Sponsor is a business with a
// brand, a status and sponsorships, nothing else.
export function SponsorShell({ session, children }: { session: SponsorSession; children: React.ReactNode }) {
  const { sponsor } = session;
  const copy = sponsorAccountStatusCopy(sponsor.status, sponsor.statusReason);
  return (
    <div className="min-h-full bg-background" data-slot="sponsor-shell">
      <header className="border-b border-border-subtle">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/sponsor" className="font-logo text-xl font-extrabold italic text-text-primary">
              brohda.
            </Link>
            <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">Sponsors</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-text-secondary sm:inline">{sponsor.displayName}</span>
            <span data-slot="sponsor-status" className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-text-primary">
              {copy.label}
            </span>
            <form action={sponsorLogoutAction}>
              <button type="submit" className="text-text-secondary underline underline-offset-4 hover:text-text-primary">
                Log out
              </button>
            </form>
          </div>
        </div>
        <nav aria-label="Sponsor" className="mx-auto flex w-full max-w-3xl gap-4 px-4 pb-2 text-sm">
          <Link href="/sponsor" className="text-text-secondary hover:text-text-primary">Dashboard</Link>
          {copy.commercialAccess && (
            <Link href="/sponsor/games" className="text-text-secondary hover:text-text-primary">Available Games</Link>
          )}
          <Link href="/sponsor/profile" className="text-text-secondary hover:text-text-primary">Profile</Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-4">{children}</main>
    </div>
  );
}
