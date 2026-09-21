import type { ReactNode } from "react";
import { requireExecutionOperationsViewer } from "@/lib/execution/authorization";
import { getExecutionPolicy } from "@/lib/execution/policy";
import { listAllKillSwitches } from "@/lib/execution/kill-switches";
import { listAllCohorts } from "@/lib/execution/cohorts";
import { listAllLimits } from "@/lib/execution/limits";
import { deriveProviderHealthStatus, listAllProviderHealth } from "@/lib/execution/provider-health";
import { listOpenMismatches } from "@/lib/execution/reconciliation/repository";
import { listRecentAuditEvents } from "@/lib/execution/audit";
import { POLYMARKET_PROVIDER } from "@/lib/prediction-markets/provider-names";
import { CreateKillSwitchForm, DisableKillSwitchButton } from "./kill-switch-controls";
import { CohortEnabledToggleButton, CohortMembershipForm, CreateCohortForm } from "./cohort-controls";
import { CreateLimitForm, LimitEnabledToggleButton, ProviderOverrideForm } from "./limit-and-provider-controls";

// Milestone 5.5 (STEP 30) — an operational surface, not a trading
// terminal: every control here toggles a policy value or shows a
// diagnostic; nothing here places, cancels, or previews a real order,
// touches a wallet, or displays a credential (none exist in this
// codebase). Gated by `view_execution_operations` (read) and, on the
// individual mutation forms, `manage_execution_controls`/
// `manage_execution_rollout` (lib/execution/authorization.ts) — never a
// direct requireSuperAdmin() call.
export default async function ExecutionOperationsPage() {
  await requireExecutionOperationsViewer();

  const [policy, killSwitches, cohorts, limits, providerHealth, mismatches, auditEvents] = await Promise.all([
    getExecutionPolicy(),
    listAllKillSwitches(),
    listAllCohorts(),
    listAllLimits(),
    listAllProviderHealth(),
    listOpenMismatches(50),
    listRecentAuditEvents(50),
  ]);

  const knownProviders = new Set([POLYMARKET_PROVIDER, ...providerHealth.map((p) => p.provider)]);
  const providerRows = Array.from(knownProviders).map((provider) => {
    const record = providerHealth.find((p) => p.provider === provider) ?? {
      provider,
      circuitState: "CLOSED" as const,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      openedAt: null,
      halfOpenProbeAt: null,
      manuallyDisabled: false,
      manualReason: null,
      manualSetBy: null,
      manualSetAt: null,
      updatedAt: new Date(0).toISOString(),
    };
    return { record, status: deriveProviderHealthStatus(record) };
  });

  return (
    <div className="space-y-8">
      <h1 className="sr-only">Execution Operations</h1>

      <section className="space-y-2">
        <p className="text-sm font-semibold text-text-primary">Global status</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatusTile label="Simulation" value={policy.simulationEnabled ? "Enabled" : "Disabled"} tone={policy.simulationEnabled ? "ok" : "warn"} />
          <StatusTile label="Rollout mode" value={policy.rolloutMode} tone={policy.rolloutMode === "OPEN" ? "ok" : "info"} />
          <StatusTile label="Active kill switches" value={String(killSwitches.filter((s) => s.enabled).length)} tone={killSwitches.some((s) => s.enabled) ? "warn" : "ok"} />
          <StatusTile label="Open mismatches" value={String(mismatches.length)} tone={mismatches.length > 0 ? "warn" : "ok"} />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Kill switches</p>
        <CreateKillSwitchForm />
        <Table
          headers={["Scope", "Target", "Reason", "Created by", "Created", "Expires", "State", ""]}
          rows={killSwitches.map((s) => [
            s.scope,
            s.target ?? "—",
            s.reason,
            s.createdBy.slice(0, 8),
            new Date(s.createdAt).toLocaleString(),
            s.expiresAt ? new Date(s.expiresAt).toLocaleString() : "—",
            s.enabled ? "Active" : `Disabled${s.disabledAt ? ` ${new Date(s.disabledAt).toLocaleString()}` : ""}`,
            s.enabled ? <DisableKillSwitchButton key={s.id} id={s.id} /> : null,
          ])}
          empty="No kill switches recorded."
        />
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Rollout cohorts</p>
        <CreateCohortForm />
        <div className="space-y-3">
          {cohorts.length === 0 && <p className="text-sm text-text-muted">No cohorts configured.</p>}
          {cohorts.map((c) => (
            <div key={c.id} className="space-y-2 rounded-lg border border-border-subtle p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {c.name} <span className="text-text-muted">({c.key})</span>
                  </p>
                  <p className="text-xs text-text-muted">
                    {c.mode}
                    {c.mode === "PERCENTAGE" ? ` · ${c.percentage}% · seed "${c.rolloutSeed}"` : ""} · {c.enabled ? "Enabled" : "Disabled"}
                  </p>
                </div>
                <CohortEnabledToggleButton id={c.id} enabled={c.enabled} />
              </div>
              {c.mode === "ALLOWLIST" && <CohortMembershipForm cohortId={c.id} />}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Provider health</p>
        <div className="space-y-2">
          {providerRows.map(({ record, status }) => (
            <div key={record.provider} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle p-3">
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {record.provider} — {status}
                </p>
                <p className="text-xs text-text-muted">
                  Circuit: {record.circuitState} · Consecutive failures: {record.consecutiveFailures}
                  {record.manuallyDisabled && record.manualReason ? ` · Manual reason: ${record.manualReason}` : ""}
                </p>
              </div>
              <ProviderOverrideForm provider={record.provider} manuallyDisabled={record.manuallyDisabled} />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Execution limits</p>
        <CreateLimitForm />
        <Table
          headers={["Scope", "Target", "Type", "Threshold", "Window (s)", "State", ""]}
          rows={limits.map((l) => [
            l.scope,
            l.target ?? "—",
            l.limitType,
            l.thresholdValue.toLocaleString(),
            l.windowSeconds ?? "—",
            l.enabled ? "Enabled" : "Disabled",
            <LimitEnabledToggleButton key={l.id} id={l.id} enabled={l.enabled} />,
          ])}
          empty="No execution limits configured."
        />
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Reconciliation mismatches (open)</p>
        <Table
          headers={["Order intent", "Result", "Created", "Details"]}
          rows={mismatches.map((m) => [m.orderIntentId.slice(0, 8), m.result, new Date(m.createdAt).toLocaleString(), JSON.stringify(m.mismatchDetails ?? {}).slice(0, 120)])}
          empty="No open reconciliation mismatches."
        />
      </section>

      <section className="space-y-3">
        <p className="text-sm font-semibold text-text-primary">Recent execution audit events</p>
        <Table
          headers={["Occurred", "Event", "Severity", "Actor", "Provider", "Correlation"]}
          rows={auditEvents.map((e) => [
            new Date(e.occurredAt).toLocaleString(),
            e.eventType,
            e.severity,
            e.actorUserId?.slice(0, 8) ?? "—",
            e.provider ?? "—",
            e.correlationId?.slice(0, 8) ?? "—",
          ])}
          empty="No execution audit events yet."
        />
      </section>
    </div>
  );
}

function StatusTile({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "info" }) {
  const toneClass = tone === "ok" ? "text-text-primary" : tone === "warn" ? "text-danger" : "text-text-secondary";
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className={`text-lg font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function Table({ headers, rows, empty }: { headers: string[]; rows: Array<Array<ReactNode>>; empty: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle">
      <table className="w-full text-sm">
        <thead className="bg-surface-secondary text-left text-text-muted">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-text-secondary">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={headers.length} className="px-3 py-8 text-center text-text-muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
