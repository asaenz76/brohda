import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { parseDateRangeParam } from "@/lib/fixtures/date-window";
import { EventsBrowser } from "./events-browser";
import { parseSportParam } from "./sport-param";

// Phase 4 (Unified Events Admin Experience): the primary place for
// finding sporting events and starting pool creation — spec §2/§3.
// "Events" not "Fixtures" as the visible admin concept; the underlying
// `fixtures` table and its query layer are unchanged (spec §34), this
// page is a new front door onto them. Server-side param parsing mirrors
// /admin/fixtures/page.tsx's own convention (malformed input degrades to
// a sane default here, real validation happens again inside the server
// action — never trust the URL alone).
export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireAdminOrAbove();
  const params = await searchParams;

  const initialPreset = parseDateRangeParam(params.range);
  const initialCustomFrom = params.from ?? "";
  const initialCustomTo = params.to ?? "";
  const initialSports = parseSportParam(params.sport);
  const initialCompetitionExternalId = params.competition ?? "";
  const initialSearch = params.q ?? "";
  const initialStatus = params.status ?? "all";
  const initialPoolStatus = params.pool ?? "all";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-text-primary">Events</h1>
        <Link href="/admin/data" className="text-xs font-medium text-text-muted hover:text-accent-primary hover:underline">
          Can&apos;t find an event? Data management
        </Link>
      </div>

      <EventsBrowser
        initialPreset={initialPreset}
        initialCustomFrom={initialCustomFrom}
        initialCustomTo={initialCustomTo}
        initialSports={initialSports}
        initialCompetitionExternalId={initialCompetitionExternalId}
        initialSearch={initialSearch}
        initialStatus={initialStatus}
        initialPoolStatus={initialPoolStatus}
      />
    </div>
  );
}
