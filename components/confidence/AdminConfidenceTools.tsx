"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { adjustConfidenceAction, reverseConfidenceEntryAction, type ConfidenceAdminResult } from "@/lib/actions/confidence-admin";

const REASONS = [
  { value: "REMEDIATION", label: "Remediation" },
  { value: "CORRECTION", label: "Correction" },
  { value: "SUPPORT_CASE", label: "Support case" },
] as const;

function Status({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
      {result.text}
    </p>
  );
}

/** A signed adjustment to one Member's available Confidence. It is recorded as a new ledger entry with a reason and a note; it never overwrites anything. */
export function AdjustConfidenceForm({ memberId }: { memberId: string }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<string>("REMEDIATION");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef(crypto.randomUUID());
  return (
    <form
      className="space-y-2"
      data-slot="adjust-confidence"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r: ConfidenceAdminResult = await adjustConfidenceAction({ memberId, amount: Number(amount), reasonCode: reason, note, idempotencyKey: key.current });
          setResult({ ok: r.success, text: r.error ?? r.message ?? "" });
          if (r.success) {
            key.current = crypto.randomUUID();
            setAmount("");
            setNote("");
          }
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Change (+ or −)
          <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} step={1} required className="block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary" />
        </label>
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)} className="block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary">
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1 text-xs font-medium text-text-secondary">
        Note (required, private)
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
      </label>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        Record adjustment
      </Button>
      <Status result={result} />
    </form>
  );
}

export function ReverseEntryButton({ entryId }: { entryId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef(crypto.randomUUID());
  if (!open) {
    return (
      <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(true)}>
        Reverse
      </Button>
    );
  }
  return (
    <div className="space-y-1" data-slot="reverse-entry">
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={1} placeholder="Why (required)" />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await reverseConfidenceEntryAction(entryId, note, key.current);
              setResult({ ok: r.success, text: r.error ?? r.message ?? "" });
            })
          }
        >
          Confirm reversal
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <Status result={result} />
    </div>
  );
}
