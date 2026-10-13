import { getSponsorIntelligencePolicy } from "@/lib/sponsor-intelligence/service";
import { SponsorIntelligenceForm } from "./SponsorIntelligenceForm";

// Settings → Brohda → Sponsorship: the Sponsor Intelligence capability and its privacy policy. Separate from the Sponsored Game Posts switch. OFF by default; fails closed.
export async function SponsorIntelligenceCard() {
  const policy = await getSponsorIntelligencePolicy().catch(() => null);
  return (
    <section aria-label="Sponsor Intelligence" data-slot="sponsor-intelligence" className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Sponsor Intelligence</h2>
      {policy ? (
        <>
          <p className="text-text-secondary">
            Status: <span className="font-medium text-text-primary" data-slot="sponsor-intelligence-state">{policy.enabled ? "On" : "Off"}</span>
          </p>
          <SponsorIntelligenceForm enabled={policy.enabled} minCohort={policy.minCohort} lookbackDays={policy.affinityLookbackDays} />
        </>
      ) : (
        <p role="alert" className="text-xs font-medium text-warning-muted">The settings couldn&apos;t be read, so Sponsors see nothing until they can.</p>
      )}
      <p className="text-xs text-text-muted">
        When on, a Sponsor sees aggregate results for their own campaigns only: how many Members saw it, took part, commented or returned. Never a Member&apos;s name, profile, Picks or messages. Any figure
        based on fewer than the threshold is withheld. Turning it off removes Sponsors&apos; access immediately; you keep the exact figures on each campaign&apos;s page.
      </p>
    </section>
  );
}
