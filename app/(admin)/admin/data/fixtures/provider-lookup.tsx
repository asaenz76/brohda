"use client";

// Phase 4 (spec §17/§18/§33): the exceptional-case escape hatch — "Can't
// find an event? Data management" links here. Everything on this page is
// an explicit, admin-initiated live provider action (spec §31): nothing
// fetches on mount. Reuses the exact same components /admin/fixtures used
// for these two flows (FixtureIdMode, ProviderDiscoveryPanel) — this is a
// relocation of where they're reached from, not a rewrite of what they do.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FixtureIdMode } from "../../fixtures/fixture-id-mode";
import { ProviderDiscoveryPanel } from "../../fixtures/date-mode/provider-discovery-panel";
import { DateToolbar } from "../../fixtures/date-mode/date-toolbar";
import { LeagueSelect, type SelectableCompetition } from "../../fixtures/league-select";
import { DEFAULT_DATE_RANGE_PRESET, type DateRangePreset } from "@/lib/fixtures/date-window";

export function ProviderLookup({ providerDisabled }: { providerDisabled: boolean }) {
  const router = useRouter();
  const [preset, setPreset] = useState<DateRangePreset>(DEFAULT_DATE_RANGE_PRESET);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [competition, setCompetition] = useState<SelectableCompetition | null>(null);
  const [showDateDiscovery, setShowDateDiscovery] = useState(false);

  if (providerDisabled) {
    return <p className="text-sm text-text-muted">API-Football is currently disabled — provider lookup and discovery are unavailable.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">Look up by fixture ID</h3>
        <p className="text-xs text-text-muted">One live request to the provider for a specific fixture ID — for troubleshooting a specific missing or mismatched event.</p>
        <FixtureIdMode providerDisabled={providerDisabled} />
      </div>

      <div className="space-y-2 border-t border-border-subtle pt-4">
        <h3 className="text-sm font-semibold text-text-primary">Discover fixtures from provider by date</h3>
        <p className="text-xs text-text-muted">For when an event should exist but hasn&apos;t been imported yet. Optionally narrow to one competition.</p>
        <button type="button" onClick={() => setShowDateDiscovery((v) => !v)} className="text-xs font-medium text-accent-primary hover:underline">
          {showDateDiscovery ? "Hide" : "Open provider discovery"}
        </button>
        {showDateDiscovery && (
          <div className="space-y-3">
            <DateToolbar preset={preset} onPresetChange={setPreset} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
            <LeagueSelect onSelect={setCompetition} />
            {competition && (
              <p className="text-xs text-text-secondary">
                Narrowed to {competition.name} ({competition.country}).{" "}
                <button type="button" onClick={() => setCompetition(null)} className="font-medium text-accent-primary hover:underline">
                  Clear
                </button>
              </p>
            )}
            <ProviderDiscoveryPanel
              key={`${preset}:${customFrom}:${customTo}:${competition?.externalLeagueId ?? ""}`}
              preset={preset}
              customFrom={customFrom}
              customTo={customTo}
              competitionExternalId={competition?.externalLeagueId}
              onImported={() => router.refresh()}
            />
          </div>
        )}
      </div>
    </div>
  );
}
