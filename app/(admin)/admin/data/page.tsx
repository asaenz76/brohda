import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";

// Phase 4 (spec §20): the home for technical/operational admin concerns —
// the machinery Events deliberately keeps out of everyday browsing.
// Nothing on this hub page itself does anything; it's a set of links to
// where each concern already lives (some pre-existing routes, some new).
function DataSection({ title, description, links }: { title: string; description: string; links: { href: string; label: string }[] }) {
  return (
    <div className="rounded-lg border border-border-subtle p-4">
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      <p className="mt-0.5 text-xs text-text-muted">{description}</p>
      <ul className="mt-3 space-y-1.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="text-sm text-accent-primary hover:underline">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function AdminDataPage() {
  await requireAdminOrAbove();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Data management</h1>
        <p className="text-sm text-text-muted">
          Technical and operational concerns behind the sports data — provider health, sync, and troubleshooting. Everyday event browsing and pool
          creation live in{" "}
          <Link href="/admin/events" className="text-accent-primary hover:underline">
            Events
          </Link>
          , not here.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DataSection
          title="Football"
          description="Supported competitions, imported seasons, discovery/sync health, and per-competition management."
          links={[{ href: "/admin/competitions", label: "Competitions" }]}
        />
        <DataSection title="NFL" description="Sync status — NFL sync is fully automatic (cron), no manual import." links={[{ href: "/admin/data/nfl", label: "NFL sync status" }]} />
        <DataSection
          title="Fixture troubleshooting"
          description="Look up a specific fixture by provider ID, discover fixtures by date, or manage a fixture record directly."
          links={[{ href: "/admin/data/fixtures", label: "Fixture troubleshooting" }]}
        />
        <DataSection
          title="Provider health"
          description="API-Football and API-NFL connection status, quota, and circuit breakers. Zero calls on load; explicit test-connection action."
          links={[{ href: "/admin/settings", label: "Provider Status (Settings)" }]}
        />
        <DataSection title="Jobs" description="Scheduled synchronization/import job health." links={[{ href: "/admin/reports", label: "Job health (Reports)" }]} />
      </div>
    </div>
  );
}
