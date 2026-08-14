"use client";

// Phase 2 primary browsing display — local date → competition → fixtures
// (spec §4), shared by By date and By competition. Every fixture here is
// already imported (this is a DB-only view), so there is no
// select/import affordance — the only action is "Create Pool", and only
// when the fixture is actually eligible (spec §15: a completed fixture
// visible through a custom range must never present a normal Create Pool
// action).
import Link from "next/link";
import type { LocalDateGroup } from "@/lib/fixtures/local-grouping";
import type { PoolEligibilityStatus } from "@/lib/fixtures/local-browse";
import { canCreatePool } from "@/lib/fixtures/local-filters";
import { COMPETITION_GROUP_LABEL } from "@/lib/sports-data/supported-competitions";
import { cn } from "@/lib/utils";

function formatKickoff(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

function formatGroupDateHeading(localDateKey: string, timeZone: string): string {
  const [y, m, d] = localDateKey.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  return noon.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone });
}

function EligibilityBadge({ status }: { status: PoolEligibilityStatus }) {
  switch (status) {
    case "ELIGIBLE":
      return null; // the "Create Pool" button itself is the signal
    case "COMPLETED":
      return <span className="shrink-0 rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] font-medium text-text-muted">Completed</span>;
    case "LOCKED":
      return <span className="shrink-0 rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] font-medium text-text-muted">Locked</span>;
    case "INELIGIBLE":
      return <span className="shrink-0 rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] font-medium text-text-muted">Not eligible</span>;
  }
}

export function LocalFixtureDateGroups({ dateGroups, timeZone }: { dateGroups: LocalDateGroup[]; timeZone: string }) {
  return (
    <div className="space-y-5">
      {dateGroups.map((dateGroup) => (
        <div key={dateGroup.localDateKey} className="space-y-2">
          <h3 className="text-sm font-semibold text-text-primary">{formatGroupDateHeading(dateGroup.localDateKey, timeZone)}</h3>

          <div className="space-y-3">
            {dateGroup.competitions.map((group) => (
              <div key={group.key} className="rounded-lg border border-border-subtle">
                <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-secondary px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {group.competitionName ?? "Unknown competition"}
                      {group.group && <span className="ml-1.5 text-xs font-normal text-text-muted">{COMPETITION_GROUP_LABEL[group.group]}</span>}
                      {!group.isSupported && <span className="ml-1.5 text-xs font-normal text-warning-muted">Unsupported</span>}
                    </p>
                    <p className="truncate text-xs text-text-muted">
                      {group.competitionCountry ?? "—"}
                      {group.season ? ` · Season ${group.season}` : ""}
                      {group.hasWorkspace ? " · Managed" : ""}
                    </p>
                  </div>
                </div>
                <div className="divide-y divide-border-subtle">
                  {group.fixtures.map((fixture) => (
                    <div key={fixture.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="w-16 shrink-0 tabular-nums text-text-secondary">{formatKickoff(fixture.scheduledStartUtc, timeZone)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text-primary">
                          {fixture.homeTeamName} vs {fixture.awayTeamName}
                        </span>
                        <span className="block text-xs text-text-muted">
                          {fixture.round ? `${fixture.round} · ` : ""}
                          {fixture.internalStatus}
                          {fixture.poolCount > 0 && (
                            <span className={cn("ml-1.5 font-medium", "text-accent-primary")}>
                              · {fixture.poolCount} pool{fixture.poolCount > 1 ? "s" : ""}
                            </span>
                          )}
                        </span>
                      </span>
                      <EligibilityBadge status={fixture.eligibility} />
                      {canCreatePool(fixture.eligibility) && (
                        <Link
                          href={`/admin/pools/new?fixtureId=${fixture.id}`}
                          className="shrink-0 rounded-full bg-accent-primary/10 px-2.5 py-1 text-[11px] font-medium text-accent-primary hover:bg-accent-primary/20"
                        >
                          Create Pool
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
