"use client";

// Phase 4 primary browsing display — local date -> sport -> competition ->
// events (spec §7/§8). Every event here is already imported (DB-only
// view), so the only action is "Create Pool", and only when eligible
// (spec §12/§30: a completed event visible through a custom range must
// never present a normal Create Pool action). Deliberately does not show
// provider name, external id, sync timestamps, or raw status codes (spec
// §7) — those live in Data Management, not here.
import Link from "next/link";
import type { LocalEventDateGroup } from "@/lib/fixtures/local-event-grouping";
import type { PoolEligibilityStatus } from "@/lib/fixtures/local-browse";
import { canCreatePool } from "@/lib/fixtures/event-filters";
import { EVENT_STATUS_LABEL, isLiveStatus } from "@/lib/fixtures/status-labels";
import { SPORT_META } from "@/lib/fixtures/sport-meta";
import { COMPETITION_GROUP_LABEL } from "@/lib/sports-data/supported-competitions";
import { cn } from "@/lib/utils";
import type { FixtureInternalStatus } from "@/lib/sports-data/types";

function formatKickoff(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

function formatGroupDateHeading(localDateKey: string, timeZone: string): string {
  const [y, m, d] = localDateKey.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  return noon.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone });
}

function StatusBadge({ status }: { status: FixtureInternalStatus }) {
  const label = EVENT_STATUS_LABEL[status];
  const live = isLiveStatus(status);
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        live ? "bg-danger/10 text-danger" : status === "NOT_STARTED" ? "bg-accent-primary/10 text-accent-primary" : "bg-surface-secondary text-text-muted",
      )}
    >
      {label}
    </span>
  );
}

function EligibilityHint({ status }: { status: PoolEligibilityStatus }) {
  switch (status) {
    case "ELIGIBLE":
      return null; // the "Create Pool" button itself is the signal
    case "COMPLETED":
      return null; // the status badge already says "Final" — no need to repeat it
    case "LOCKED":
      return <span className="shrink-0 text-[11px] text-text-muted">Locked</span>;
    case "INELIGIBLE":
      return <span className="shrink-0 text-[11px] text-text-muted">Not eligible</span>;
  }
}

export function EventDateGroups({ dateGroups, timeZone }: { dateGroups: LocalEventDateGroup[]; timeZone: string }) {
  return (
    <div className="space-y-6">
      {dateGroups.map((dateGroup) => (
        <div key={dateGroup.localDateKey} className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">{formatGroupDateHeading(dateGroup.localDateKey, timeZone)}</h3>

          <div className="space-y-4">
            {dateGroup.sports.map((sportGroup) => {
              const meta = SPORT_META[sportGroup.sport];
              return (
                <div key={sportGroup.sport} className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    <span aria-hidden="true">{meta.icon}</span>
                    <span>{meta.label}</span>
                  </div>

                  <div className="space-y-3">
                    {sportGroup.competitions.map((group) => (
                      <div key={group.key} className="rounded-lg border border-border-subtle">
                        <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-secondary px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-text-primary">
                              {group.competitionName ?? "Unknown competition"}
                              {group.group && <span className="ml-1.5 text-xs font-normal text-text-muted">{COMPETITION_GROUP_LABEL[group.group]}</span>}
                            </p>
                            {group.competitionCountry && <p className="truncate text-xs text-text-muted">{group.competitionCountry}</p>}
                          </div>
                        </div>
                        <div className="divide-y divide-border-subtle">
                          {group.fixtures.map((fixture) => (
                            <div key={fixture.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-sm">
                              <span className="w-16 shrink-0 tabular-nums text-text-secondary">{formatKickoff(fixture.scheduledStartUtc, timeZone)}</span>
                              {/* min-w-[10rem] (not truncate) — team names must stay fully legible on
                                  narrow screens (spec §27); this block wraps to its own line instead
                                  of ellipsis-cutting a name mid-word. */}
                              <span className="min-w-[10rem] flex-1 basis-48">
                                <span className="block font-medium text-text-primary">
                                  {fixture.homeTeamName} vs {fixture.awayTeamName}
                                </span>
                                <span className="block text-xs text-text-muted">
                                  {fixture.round ? `${fixture.round}` : ""}
                                  {fixture.poolCount > 0 && (
                                    <Link href={`/admin/pools?fixtureId=${fixture.id}`} className={cn("ml-1.5 font-medium hover:underline", "text-accent-primary")}>
                                      {fixture.round ? "· " : ""}
                                      {fixture.poolCount} pool{fixture.poolCount > 1 ? "s" : ""}
                                    </Link>
                                  )}
                                </span>
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                <StatusBadge status={fixture.internalStatus} />
                                <EligibilityHint status={fixture.eligibility} />
                                {canCreatePool(fixture.eligibility) && (
                                  <Link
                                    href={`/admin/pools/new?fixtureId=${fixture.id}`}
                                    className="shrink-0 rounded-full bg-accent-primary/10 px-2.5 py-1 text-[11px] font-medium text-accent-primary hover:bg-accent-primary/20"
                                  >
                                    Create Pool
                                  </Link>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
