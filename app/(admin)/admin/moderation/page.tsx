import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalDateTime } from "@/components/LocalDateTime";
import { ReportActions } from "@/components/messaging/ReportActions";

export const dynamic = "force-dynamic";

// Message reports, for Super Admin only. This is NOT a way to browse messages: it lists reports, each with the bounded evidence snapshot taken when it was filed (the reported message and a few before
// it). Nothing here can open an arbitrary conversation. Every resolution is audited.
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

const first = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export default async function ModerationPage() {
  await requireSuperAdmin();
  const admin = createAdminClient();
  const select: string = "id, scope, reason, note, status, evidence, message_id, created_at, resolved_at, resolution_note, reporter:reporter_id(display_name), reported:reported_member_id(display_name)";
  const [{ data: open }, { data: resolved }] = await Promise.all([
    admin.from("message_reports").select(select).eq("status", "OPEN").order("created_at", { ascending: true }).limit(100),
    admin.from("message_reports").select(select).neq("status", "OPEN").order("resolved_at", { ascending: false }).limit(20),
  ]);
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
      <h1 className="text-lg font-semibold text-text-primary">Message reports</h1>
      <section aria-label="Open reports" className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Open ({openRows.length})</h2>
        {openRows.length === 0 ? <p className="text-sm text-text-muted">No open reports.</p> : <ul className="space-y-2">{openRows.map(card)}</ul>}
      </section>
      {resolvedRows.length > 0 && (
        <section aria-label="Recently resolved" className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Recently resolved</h2>
          <ul className="space-y-2">{resolvedRows.map(card)}</ul>
        </section>
      )}
    </div>
  );
}
