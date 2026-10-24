"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setMarketPolicyAction, type MarketPolicyAdminResult } from "@/lib/actions/market-policy-admin";
import { MARKET_TEMPLATES, type MarketPolicy } from "@/lib/prediction-markets/market-policy-parse";

const LABEL: Record<string, string> = { MONEYLINE: "Team winner (Moneyline)", SPREAD: "Spread", TOTAL: "Total" };

function TemplateList({ name, value, onChange, disabled }: { name: string; value: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap gap-3" role="group" aria-label={name}>
      {MARKET_TEMPLATES.map((t) => (
        <label key={t} className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={value.includes(t)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((v) => v !== t))} />
          {LABEL[t]}
        </label>
      ))}
    </div>
  );
}

/**
 * Super Admin: what Members can START new interaction with, whether a price is needed, whether a Game gets its Market without odds, and what ingestion writes. Every save is one audited call.
 * Nothing here rewrites a Pick, a Market or a ledger entry; hidden Market types stay in history and existing commitments finish.
 */
export function MarketPolicyCard({ initial }: { initial: MarketPolicy }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<MarketPolicyAdminResult | null>(null);
  const [allowed, setAllowed] = useState<string[]>(initial.allowedTemplates);
  const [ingestion, setIngestion] = useState<string[]>(initial.ingestionTemplates);
  const [fixtureMarkets, setFixtureMarkets] = useState(initial.fixtureMarketsEnabled);
  const [requirePrice, setRequirePrice] = useState(initial.requirePrice);
  const dirty =
    fixtureMarkets !== initial.fixtureMarketsEnabled ||
    requirePrice !== initial.requirePrice ||
    [...allowed].sort().join() !== [...initial.allowedTemplates].sort().join() ||
    [...ingestion].sort().join() !== [...initial.ingestionTemplates].sort().join();
  const save = () => start(async () => setResult(await setMarketPolicyAction({ fixtureMarketsEnabled: fixtureMarkets, requirePrice, allowedTemplates: allowed, ingestionTemplates: ingestion })));

  return (
    <section aria-label="Markets and Picks policy" data-slot="market-policy" className="space-y-3 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Markets &amp; Picks policy</h2>
      <p className="text-xs text-text-muted">
        Decides what Members are offered and where Markets come from. Changing it never rewrites a Pick, a Market or the Confidence ledger. Market types that are turned off stay in history, and Picks already made are finished normally.
      </p>

      <div className="space-y-1" data-slot="market-policy-allowed">
        <p className="font-medium text-text-primary">Members can start a Pick or a Call BS on</p>
        <TemplateList name="Member Market types" value={allowed} onChange={setAllowed} disabled={pending} />
        {allowed.length === 0 && <p className="text-xs text-destructive">Nothing is selected: Members cannot start any new Pick.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2" data-slot="market-policy-require-price">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={requirePrice} disabled={pending} onChange={(e) => setRequirePrice(e.target.checked)} />
          <span className="font-medium text-text-primary">A Market needs a usable sportsbook price before Members can Pick it</span>
        </label>
        <span className="text-xs text-text-muted">Off: a team-winner Pick stays open until the real deadline even with no odds; a Pick made with no price records none.</span>
      </div>

      <div className="flex flex-wrap items-center gap-2" data-slot="market-policy-fixture-markets">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={fixtureMarkets} disabled={pending} onChange={(e) => setFixtureMarkets(e.target.checked)} />
          <span className="font-medium text-text-primary">Create each upcoming Game&apos;s team-winner Market from the Game itself</span>
        </label>
        <span className="text-xs text-text-muted">One Market per Game, no price. Odds that arrive later fill in the same Market.</span>
      </div>

      <div className="space-y-1" data-slot="market-policy-ingestion">
        <p className="font-medium text-text-primary">Sportsbook ingestion creates and updates</p>
        <TemplateList name="Ingestion Market types" value={ingestion} onChange={setIngestion} disabled={pending} />
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={pending || !dirty} onClick={save}>
          Save policy
        </Button>
        {result && (
          <p role={result.success ? "status" : "alert"} className={result.success ? "text-xs text-text-secondary" : "text-xs text-destructive"}>
            {result.success ? result.message : result.error}
          </p>
        )}
      </div>
    </section>
  );
}
