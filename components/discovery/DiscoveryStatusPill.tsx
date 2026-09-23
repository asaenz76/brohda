import { Badge } from "@/components/ui/badge";
import type { ConsumerMarketStatus, Freshness } from "@/lib/prediction-markets/discovery/types";

// Centralized status/freshness presentation (roadmap STEP 16: "status
// presentation rules should be centralized, not reinvented per
// component"). Text always accompanies color — meaning is never carried by
// color alone (roadmap STEP 24 accessibility requirement).

export function DiscoveryStatusPill({ status }: { status: ConsumerMarketStatus }) {
  if (status === "ACTIVE") return null; // the default, unremarkable state — no pill needed
  if (status === "RESOLVED") return <Badge variant="primary">Resolved</Badge>;
  return <Badge variant="secondary">Closed</Badge>;
}

export function FreshnessNote({ freshness }: { freshness: Freshness }) {
  if (freshness === "FRESH") return null;
  if (freshness === "STALE") {
    return <p className="text-xs text-text-muted">Pricing may be a little out of date.</p>;
  }
  return <p className="text-xs text-text-muted">Pricing isn&apos;t available right now.</p>;
}
