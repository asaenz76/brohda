import { Compass } from "lucide-react";
import Link from "next/link";
import { listUserOrderIntents } from "@/lib/execution/repository";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { Card, CardContent } from "@/components/ui/card";

// Milestone 5's simulated-execution history (roadmap STEP 29). Deliberately
// a THIRD, separate tab/component from both the legacy Predictions tab
// (pool entries) and the Milestone 3 Market Predictions tab (Prediction
// domain) — this shows OrderIntent records only, never mixed with either.
// Self-history only, mirroring Milestone 3's own visibility decision.

export async function SimulatedExecutionTab({ userId }: { userId: string }) {
  const orderIntents = await listUserOrderIntents(userId);

  if (orderIntents.length === 0) {
    return (
      <EmptyFeedState
        icon={Compass}
        title="No simulated executions yet"
        description="Try a simulated prediction on a market to see it here. No real money is ever involved."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Simulated only — no real money has ever moved</p>
      {orderIntents.map((intent) => (
        <Card key={intent.id}>
          <CardContent className="space-y-1 pt-4">
            <Link href={`/markets/${intent.marketId}`} className="text-sm font-semibold text-text-primary hover:underline">
              {intent.selectedSide} · ${(intent.requestedAmountCents / 100).toFixed(2)}
            </Link>
            <p className="text-xs text-text-muted">
              Simulated at {Math.round(intent.quotedEffectivePrice * 100)}% ·{" "}
              {new Date(intent.confirmedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
            </p>
            <p className="text-xs font-medium text-text-muted">
              {intent.lifecycleState === "SIMULATED_FILLED" ? "Simulated fill" : intent.lifecycleState === "SIMULATED_REJECTED" ? "Not confirmed" : "Processing"}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
