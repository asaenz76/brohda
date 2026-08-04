"use client";

import { useActionState } from "react";
import { searchFixturesAction, type FixtureSearchState } from "@/lib/actions/fixtures";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { FixtureResultsList } from "./fixture-results-list";

const initialSearchState: FixtureSearchState = { error: null, providerDisabled: false, results: [] };

/**
 * The preserved direct-lookup workflow — troubleshooting, one-off
 * imports, importing a known event, verifying a provider fixture
 * directly. Deliberately minimal: no date-range or competition controls
 * (see spec §9) — just an ID in, a normalized record out.
 */
export function FixtureIdMode({ providerDisabled }: { providerDisabled: boolean }) {
  const [state, formAction, pending] = useActionState(searchFixturesAction, initialSearchState);

  if (providerDisabled) {
    return (
      <p className="text-sm text-text-secondary">
        The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code> and a valid <code>API_FOOTBALL_KEY</code> to look up and
        import a fixture.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <form action={formAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="mode" value="by_id" />
            <div className="space-y-1.5">
              <Label htmlFor="externalFixtureId">Fixture ID</Label>
              <Input id="externalFixtureId" name="externalFixtureId" placeholder="215662" className="w-36" />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Looking up…" : "Look up fixture"}
            </Button>
          </form>

          {state.error && <p className="text-sm text-danger">{state.error}</p>}
          {state.providerDisabled && (
            <p className="text-sm text-text-secondary">
              The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code> and a valid <code>API_FOOTBALL_KEY</code> to look up a
              fixture.
            </p>
          )}
          {!state.providerDisabled && !state.error && state.results.length === 0 && pending === false && (
            <p className="text-sm text-text-muted">Enter a provider fixture ID above to look it up.</p>
          )}
        </CardContent>
      </Card>

      {state.results.length > 0 && <FixtureResultsList fixtures={state.results} />}
    </div>
  );
}
