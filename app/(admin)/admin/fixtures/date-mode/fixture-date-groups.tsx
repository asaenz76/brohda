"use client";

import type { DateGroup } from "@/lib/fixtures/grouping";
import { COMPETITION_GROUP_LABEL } from "@/lib/sports-data/supported-competitions";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function formatKickoff(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

function formatGroupDateHeading(localDateKey: string, timeZone: string): string {
  // localDateKey is YYYY-MM-DD in `timeZone` already — render it as a
  // weekday + month + day using that same zone's calendar, constructed
  // at local noon to stay safely clear of any date-line/DST edge.
  const [y, m, d] = localDateKey.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  return noon.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone });
}

export function FixtureDateGroups({
  dateGroups,
  timeZone,
  selected,
  disabled,
  onToggleFixture,
  onSelectDate,
  onSelectCompetition,
}: {
  dateGroups: DateGroup[];
  timeZone: string;
  selected: Set<string>;
  disabled: boolean;
  onToggleFixture: (id: string) => void;
  onSelectDate: (localDateKey: string, fixtureIds: string[]) => void;
  onSelectCompetition: (key: string, fixtureIds: string[]) => void;
}) {
  return (
    <div className="space-y-5">
      {dateGroups.map((dateGroup) => {
        const eligibleOnDate = dateGroup.competitions.flatMap((c) => c.fixtures.filter((f) => !f.isImported).map((f) => f.externalFixtureId));
        return (
          <div key={dateGroup.localDateKey} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-text-primary">{formatGroupDateHeading(dateGroup.localDateKey, timeZone)}</h3>
              {eligibleOnDate.length > 0 && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelectDate(dateGroup.localDateKey, eligibleOnDate)}
                  className="text-xs font-medium text-accent-primary hover:underline disabled:opacity-50"
                >
                  Select all on this date ({eligibleOnDate.length})
                </button>
              )}
            </div>

            <div className="space-y-3">
              {dateGroup.competitions.map((group) => {
                const eligibleInGroup = group.fixtures.filter((f) => !f.isImported).map((f) => f.externalFixtureId);
                return (
                  <div key={group.key} className="rounded-lg border border-border-subtle">
                    <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-secondary px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {group.competitionName ?? "Unknown competition"}
                          {group.group && (
                            <span className="ml-1.5 text-xs font-normal text-text-muted">{COMPETITION_GROUP_LABEL[group.group]}</span>
                          )}
                          {!group.isSupported && <span className="ml-1.5 text-xs font-normal text-warning-muted">Unsupported</span>}
                        </p>
                        <p className="truncate text-xs text-text-muted">
                          {group.competitionCountry ?? "—"}
                          {group.season ? ` · Season ${group.season}` : ""}
                          {group.hasWorkspace ? " · Managed" : ""}
                        </p>
                      </div>
                      {eligibleInGroup.length > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={disabled}
                          onClick={() => onSelectCompetition(group.key, eligibleInGroup)}
                        >
                          Select competition ({eligibleInGroup.length})
                        </Button>
                      )}
                    </div>
                    <div className="divide-y divide-border-subtle">
                      {group.fixtures.map((fixture) => (
                        <label
                          key={fixture.externalFixtureId}
                          className={cn(
                            "flex items-center gap-3 px-3 py-2 text-sm",
                            fixture.isImported ? "opacity-60" : "cursor-pointer hover:bg-surface-secondary",
                          )}
                        >
                          <Checkbox
                            checked={fixture.isImported || selected.has(fixture.externalFixtureId)}
                            disabled={disabled || fixture.isImported}
                            onCheckedChange={() => !fixture.isImported && onToggleFixture(fixture.externalFixtureId)}
                          />
                          <span className="w-16 shrink-0 tabular-nums text-text-secondary">
                            {formatKickoff(fixture.scheduledStartUtc, timeZone)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-text-primary">
                              {fixture.homeTeamName} vs {fixture.awayTeamName}
                            </span>
                            <span className="block text-xs text-text-muted">
                              {fixture.round ? `${fixture.round} · ` : ""}
                              {fixture.internalStatus}
                            </span>
                          </span>
                          {fixture.isImported ? (
                            <a
                              href={`/admin/fixtures#${fixture.importedFixtureId}`}
                              className="shrink-0 rounded-full bg-credit/15 px-2 py-0.5 text-[11px] font-medium text-credit hover:underline"
                            >
                              Imported
                            </a>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
