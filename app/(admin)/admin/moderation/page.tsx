import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalDateTime } from "@/components/LocalDateTime";
import { ReportActions } from "@/components/messaging/ReportActions";
import { LiftRestriction, PlaceReportHold, ReleaseHold, SignalActions } from "@/components/messaging/ModerationControls";

export const dynamic = "force-dynamic";

// Message reports, abuse signals, temporary restrictions and retention holds — for Super Admin only. This is NOT a way to browse messages: it lists reports, each with the bounded evidence snapshot taken
// when it was filed (the reported message and a few before it). Signals carry counts and the rule that fired, never message content, an IP or a device. Nothing here can open an arbitrary conversation.
// Every action is audited.
interface EvidenceItem {
  seq: number;
  at: string;
  from: "reporter" | "reported";
  kind: string;
  body: string | null;
  shareType: string | null;
  unsent: boolean;
}

interface ReportRow {
  id: string;
  scope: "MESSAGE" | "CONVERSATION";
  reason: string;
  note: string | null;
  status: "OPEN" | "ACTIONED" | "DISMISSED";
  evidence: EvidenceItem[];
  message_id: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  reporter: { display_name: string } | { display_name: string }[] | null;
  reported: { display_name: string } | { display_name: string }[] | null;
}

interface SignalRow {
  id: string;
  signal_type: string;
  observed_count: number;
  threshold: number;
  window_seconds: number;
  response: "FLAGGED" | "RESTRICTED";
  first_seen_at: string;
  last_seen_at: string;
  member: { display_name: string } | { display_name: string }[] | null;
}

interface RestrictionRow {
  id: string;
  rule: string;
  ends_at: string;
  member: { display_name: string } | { display_name: string }[] | null;
}

interface HoldRow {
  id: string;
  reason: string;
  scope: string;
  note: string;
  placed_at: string;
  report_id: string | null;
}

const SIGNAL_LABEL: Record<string, string> = {
  EXCESSIVE_REQUESTS: "Many new Message Requests",
  REPEATED_DECLINES: "Repeated declines of their requests",
  REPEATED_BLOCKS: "Blocked by several Members",
  REPEATED_REPORTS: "Reported by several Members",
  DUPLICATE_BURST: "The same message sent repeatedly",
  RAPID_MESSAGING: "Unusually rapid messaging",
  COORDINATED_TARGETING: "Many Members requesting one Member",
};

const HOLD_LABEL: Record<string, string> = { ABUSE_INVESTIGATION: "Abuse investigation", MODERATION_CASE: "Moderation case", LEGAL_OBLIGATION: "Legal obligation" };

const first = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export default async function ModerationPage() {
  await requireSuperAdmin();
  const admin = createAdminClient();
  const select: string = "id, scope, reason, note, status, evidence, message_id, created_at, resolved_at, resolution_note, reporter:reporter_id(display_name), reported:reported_member_id(display_name)";
  const [{ data: open }, { data: resolved }, { data: signals }, { data: restrictions }, { data: holds }] = await Promise.all([
    admin.from("message_reports").select(select).eq("status", "OPEN").order("created_at", { ascending: true }).limit(100),
    admin.from("message_reports").select(select).neq("status", "OPEN").order("resolved_at", { ascending: false }).limit(20),
    admin.from("messaging_abuse_signals").select("id, signal_type, observed_count, threshold, window_seconds, response, first_seen_at, last_seen_at, member:member_id(display_name)").eq("status", "OPEN").order("last_seen_at", { ascending: false }).limit(100),
    admin.from("messaging_restrictions").select("id, rule, ends_at, member:member_id(display_name)").is("lifted_at", null).gt("ends_at", new Date().toISOString()).order("ends_at", { ascending: true }).limit(100),
    admin.from("messaging_retention_holds").select("id, reason, scope, note, placed_at, report_id").is("released_at", null).order("placed_at", { ascending: false }).limit(100),
  ]);
  const signalRows = (signals ?? []) as unknown as SignalRow[];
  const restrictionRows = (restrictions ?? []) as unknown as RestrictionRow[];
  const holdRows = (holds ?? []) as unknown as HoldRow[];
  const holdByReport = new Map(holdRows.filter((h) => h.report_id).map((h) => [h.report_id as string, h]));
  const openRows = (open ?? []) as unknown as ReportRow[];
  const resolvedRows = (resolved ?? []) as unknown as ReportRow[];

  const card = (r: ReportRow) => (
    <li key={r.id} data-slot="report" data-status={r.status} className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold text-text-primary">
          {r.scope === "MESSAGE" ? "Message" : "Conversation"} · {r.reason.charAt(0) + r.reason.slice(1).toLowerCase()}
        </p>
        <p className="text-xs text-text-muted">
          <LocalDateTime iso={r.created_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
        </p>
      </div>
      <p className="text-xs text-text-secondary">
        Reported by {first(r.reporter)?.display_name ?? "a removed account"} · about {first(r.reported)?.display_name ?? "a removed account"}
      </p>
      {r.note && <p className="text-text-primary">&ldquo;{r.note}&rdquo;</p>}
      <details>
        <summary className="cursor-pointer text-xs font-medium text-text-secondary">Evidence ({r.evidence.length} message{r.evidence.length === 1 ? "" : "s"})</summary>
        {r.evidence.length === 0 ? (
          <p className="mt-1 text-xs text-text-muted">The evidence has been cleared under the retention policy.</p>
        ) : (
          <ol className="mt-1 space-y-1">
            {r.evidence.map((e) => (
              <li key={e.seq} className="rounded bg-surface-secondary px-2 py-1 text-xs">
                <span className="font-semibold text-text-primary">{e.from === "reported" ? "Reported" : "Reporter"}</span>{" "}
                <span className="text-text-muted">#{e.seq}{e.unsent ? " · deleted by sender" : ""}</span>
                <span className="block whitespace-pre-wrap break-words text-text-primary">{e.kind === "SHARE" ? `Shared a ${e.shareType ?? "object"}` : e.body}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
      {holdByReport.has(r.id) && (
        <p className="text-xs font-medium text-text-primary" data-slot="report-hold">
          On retention hold · {HOLD_LABEL[holdByReport.get(r.id)?.reason ?? ""] ?? "Hold"}
        </p>
      )}
      {holdByReport.has(r.id) ? <ReleaseHold holdId={holdByReport.get(r.id)?.id as string} /> : <PlaceReportHold reportId={r.id} />}
      {r.status === "OPEN" ? (
        <ReportActions reportId={r.id} hasMessage={r.message_id !== null} />
      ) : (
        <p className="text-xs text-text-muted">
          {r.status === "DISMISSED" ? "Dismissed" : "Actioned"}
          {r.resolved_at && (
            <>
              {" "}
              <LocalDateTime iso={r.resolved_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
            </>
          )}
          {r.resolution_note ? ` — ${r.resolution_note}` : ""}
        </p>
      )}
    </li>
  );

  return (
    <div className="space-y-4" data-slot="moderation">
      <h1 className="text-lg font-semibold text-text-primary">Moderation</h1>
      <section aria-label="Open reports" className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Open ({openRows.length})</h2>
        {openRows.length === 0 ? <p className="text-sm text-text-muted">No open reports.</p> : <ul className="space-y-2">{openRows.map(card)}</ul>}
      </section>
      <section aria-label="Abuse signals" data-slot="abuse-signals" className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Abuse signals ({signalRows.length})</h2>
        <p className="text-xs text-text-muted">Flags raised by the configured thresholds. They are prompts for a person to look, not verdicts: nobody is banned or deleted automatically.</p>
        {signalRows.length === 0 ? (
          <p className="text-sm text-text-muted">No open signals.</p>
        ) : (
          <ul className="space-y-2">
            {signalRows.map((g) => (
              <li key={g.id} data-slot="abuse-signal" data-type={g.signal_type} className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
                <p className="font-semibold text-text-primary">{SIGNAL_LABEL[g.signal_type] ?? g.signal_type}</p>
                <p className="text-xs text-text-secondary">
                  {first(g.member)?.display_name ?? "A removed account"} · {g.observed_count} (limit {g.threshold}) within {Math.round(g.window_seconds / 60)} min · {g.response === "RESTRICTED" ? "temporary restriction applied" : "flagged only"}
                </p>
                <SignalActions signalId={g.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {restrictionRows.length > 0 && (
        <section aria-label="Active restrictions" data-slot="restrictions" className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Active restrictions ({restrictionRows.length})</h2>
          <ul className="space-y-2">
            {restrictionRows.map((x) => (
              <li key={x.id} data-slot="restriction" className="space-y-1 rounded-lg border border-border-subtle p-3 text-sm">
                <p className="text-text-primary">
                  {first(x.member)?.display_name ?? "A removed account"} can&apos;t open new Message Requests until{" "}
                  <LocalDateTime iso={x.ends_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                </p>
                <p className="text-xs text-text-muted">Rule: {SIGNAL_LABEL[x.rule] ?? x.rule}. Existing conversations are unaffected.</p>
                <LiftRestriction restrictionId={x.id} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {holdRows.length > 0 && (
        <section aria-label="Retention holds" data-slot="holds" className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Retention holds ({holdRows.length})</h2>
          <ul className="space-y-2">
            {holdRows.map((h) => (
              <li key={h.id} data-slot="hold" className="space-y-1 rounded-lg border border-border-subtle p-3 text-sm">
                <p className="text-text-primary">
                  {HOLD_LABEL[h.reason] ?? h.reason} · {h.scope === "REPORT" ? "one report" : h.scope === "MESSAGE" ? "one message" : "a range of messages"}
                </p>
                <p className="text-xs text-text-muted">{h.note}</p>
                <ReleaseHold holdId={h.id} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {resolvedRows.length > 0 && (
        <section aria-label="Recently resolved" className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Recently resolved</h2>
          <ul className="space-y-2">{resolvedRows.map(card)}</ul>
        </section>
      )}
    </div>
  );
}
