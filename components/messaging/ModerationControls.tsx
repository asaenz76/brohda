"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  liftRestrictionAction,
  placeRetentionHoldAction,
  releaseRetentionHoldAction,
  resolveAbuseSignalAction,
  type HoldReason,
  type MessagingAdminResult,
} from "@/lib/actions/messaging-admin";

// Super Admin controls on the moderation page. Each one calls an audited, Super Admin-only server action; none of them can browse or read anything.

function Status({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
      {result.text}
    </p>
  );
}

function useRun() {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<MessagingAdminResult>) =>
    startTransition(async () => {
      const r = await fn();
      setResult({ ok: r.success, text: r.error ?? r.message ?? "" });
      if (r.success) setDone(true);
    });
  return { result, done, pending, run };
}

const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  ABUSE_INVESTIGATION: "Active abuse investigation",
  MODERATION_CASE: "Unresolved moderation case",
  LEGAL_OBLIGATION: "Legal obligation",
};

/** Place a retention hold on ONE report: its record, its evidence and the message it names — nothing else in the conversation or the Members' history. */
export function PlaceReportHold({ reportId }: { reportId: string }) {
  const [reason, setReason] = useState<HoldReason>("MODERATION_CASE");
  const [note, setNote] = useState("");
  const { result, done, pending, run } = useRun();
  if (done) return <Status result={result} />;
  return (
    <details data-slot="place-hold">
      <summary className="cursor-pointer text-xs font-medium text-text-secondary">Place a retention hold</summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-text-muted">Keeps only this report, its evidence and the message it names past the retention schedule. Everything else is unaffected.</p>
        <label className="block space-y-1 text-xs font-medium text-text-secondary">
          Reason
          <select value={reason} onChange={(e) => setReason(e.target.value as HoldReason)} className="block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary">
            {(Object.keys(HOLD_REASON_LABEL) as HoldReason[]).map((r) => (
              <option key={r} value={r}>
                {HOLD_REASON_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-xs font-medium text-text-secondary">
          Why (required)
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
        </label>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => placeRetentionHoldAction({ reason, scope: "REPORT", reportId, note }))}>
          Place hold
        </Button>
        <Status result={result} />
      </div>
    </details>
  );
}

export function ReleaseHold({ holdId }: { holdId: string }) {
  const [note, setNote] = useState("");
  const { result, done, pending, run } = useRun();
  if (done) return <Status result={result} />;
  return (
    <div className="space-y-1" data-slot="release-hold">
      <label className="block space-y-1 text-xs font-medium text-text-secondary">
        Note (optional)
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={1} />
      </label>
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => releaseRetentionHoldAction(holdId, note))}>
        Release hold
      </Button>
      <Status result={result} />
    </div>
  );
}

export function SignalActions({ signalId }: { signalId: string }) {
  const [note, setNote] = useState("");
  const { result, done, pending, run } = useRun();
  if (done) return <Status result={result} />;
  return (
    <div className="space-y-2" data-slot="signal-actions">
      <label className="block space-y-1 text-xs font-medium text-text-secondary">
        Note (kept with the record)
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => resolveAbuseSignalAction(signalId, "DISMISS", note))}>
          Dismiss
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => resolveAbuseSignalAction(signalId, "REVIEW", note))}>
          Mark reviewed
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => resolveAbuseSignalAction(signalId, "ACTION", note))}>
          Mark actioned
        </Button>
      </div>
      <Status result={result} />
    </div>
  );
}

export function LiftRestriction({ restrictionId }: { restrictionId: string }) {
  const { result, done, pending, run } = useRun();
  if (done) return <Status result={result} />;
  return (
    <div className="space-y-1" data-slot="lift-restriction">
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run(() => liftRestrictionAction(restrictionId, ""))}>
        Lift restriction
      </Button>
      <Status result={result} />
    </div>
  );
}
