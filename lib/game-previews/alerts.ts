import "server-only";
import * as Sentry from "@sentry/nextjs";

/**
 * Operational alerts for the scheduled Game Preview automation, through the existing Sentry integration (the same one every degraded cron job uses). A normal needs_review is NOT an alert. Nothing here changes a setting or repairs anything: detection and visibility only.
 */
export type AutomationAlertKind =
  | "provider_credit_exhausted"
  | "provider_auth_failed"
  | "technical_failure"
  | "repeated_technical_failure"
  | "json_not_recovered"
  | "scheduler_exception"
  | "status_source_blocked"
  | "stale_current_blocked"
  | "refresh_hid_preview";

const LEVEL: Record<AutomationAlertKind, "fatal" | "error" | "warning"> = {
  provider_credit_exhausted: "fatal",
  provider_auth_failed: "fatal",
  technical_failure: "error",
  repeated_technical_failure: "error",
  json_not_recovered: "error",
  scheduler_exception: "error",
  status_source_blocked: "warning",
  stale_current_blocked: "warning",
  refresh_hid_preview: "warning",
};

export interface AutomationAlert {
  kind: AutomationAlertKind;
  message: string;
  /** Non-secret identifiers only (Game and invocation ids): never prompts, article text or model output. */
  context?: Record<string, string | number | null>;
}

export function raiseAutomationAlert(alert: AutomationAlert): void {
  try {
    Sentry.captureMessage(`game-preview-automation: ${alert.message}`, { level: LEVEL[alert.kind], tags: { area: "game-preview-automation", alert: alert.kind, priority: LEVEL[alert.kind] === "warning" ? "review" : "high" }, extra: alert.context });
  } catch {
    /* an alert must never fail a run */
  }
}
