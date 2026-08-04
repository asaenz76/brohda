import type { ProviderStatus } from "@/lib/sports-data/provider-gateway";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const QUOTA_BADGE: Record<ProviderStatus["quotaState"], { label: string; className: string }> = {
  OK: { label: "OK", className: "bg-credit/10 text-credit" },
  EXHAUSTED: { label: "Exhausted", className: "bg-danger/10 text-danger" },
  UNKNOWN: { label: "Unknown", className: "bg-warning-muted/20 text-text-secondary" },
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

// Read-only snapshot of lib/sports-data/provider-gateway.ts's
// getProviderStatus() — derived entirely from provider_request_log, so
// this reflects exactly what every background job's own circuit-breaker
// check sees. Deliberately shows the real 24h request count rather than
// an "estimated requests remaining" figure — API-Football's actual daily
// cap for this account was never confirmed by a documented value, and
// fabricating one would be worse than omitting it.
export function ProviderStatusPanel({ status }: { status: ProviderStatus }) {
  if (!status.enabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provider status</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-secondary">
            The sports data provider isn&apos;t enabled. Set <code>API_FOOTBALL_ENABLED=true</code> and a valid <code>API_FOOTBALL_KEY</code> to use it.
          </p>
        </CardContent>
      </Card>
    );
  }

  const badge = QUOTA_BADGE[status.quotaState];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
            Quota: {badge.label}
          </span>
          {status.circuitBreakerOpen && (
            <span className="inline-flex items-center rounded-full bg-danger/10 px-2.5 py-0.5 text-xs font-medium text-danger">
              Circuit breaker open — background sync paused
            </span>
          )}
        </div>

        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-text-muted">Requests in the last 24h</dt>
            <dd className="font-medium text-text-primary">{status.requestsLast24h}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Last successful request</dt>
            <dd className="font-medium text-text-primary">{formatTimestamp(status.lastSuccessfulRequestAt)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Last error</dt>
            <dd className="font-medium text-text-primary">{formatTimestamp(status.lastErrorAt)}</dd>
          </div>
          {status.lastErrorMessage && (
            <div className="sm:col-span-2">
              <dt className="text-text-muted">Last error message</dt>
              <dd className="break-words font-medium text-danger">{status.lastErrorMessage}</dd>
            </div>
          )}
        </dl>

        <p className="text-xs text-text-muted">
          While the circuit breaker is open, scheduled competition sync and the recommendation availability cache skip
          their run rather than retry — see Competition Workspace &quot;Sync now&quot; for a manual, single-competition
          retry once quota is likely available again.
        </p>
      </CardContent>
    </Card>
  );
}
