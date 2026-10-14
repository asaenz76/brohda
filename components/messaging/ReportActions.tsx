"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { resolveMessageReportAction } from "@/lib/actions/messaging-admin";

export function ReportActions({ reportId, hasMessage }: { reportId: string; hasMessage: boolean }) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const run = (action: "DISMISS" | "HIDE_MESSAGE" | "ACTION") =>
    startTransition(async () => {
      const r = await resolveMessageReportAction(reportId, action, note);
      setStatus({ ok: r.success, text: r.error ?? r.message ?? "" });
      if (r.success) setDone(true);
    });
  return (
    <div className="space-y-2" data-slot="report-actions">
      {!done && (
        <label className="block space-y-1 text-xs font-medium text-text-secondary">
          Note (kept with the record)
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
        </label>
      )}
      <div className={done ? "hidden" : "flex flex-wrap gap-2"}>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run("DISMISS")}>
          Dismiss
        </Button>
        {hasMessage && (
          <Button type="button" variant="destructive" size="sm" disabled={pending} onClick={() => run("HIDE_MESSAGE")}>
            Hide message
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => run("ACTION")}>
          Mark actioned
        </Button>
      </div>
      {status && (
        <p role={status.ok ? "status" : "alert"} className={status.ok ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
          {status.text}
        </p>
      )}
    </div>
  );
}
