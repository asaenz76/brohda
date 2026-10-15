"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { claimDailyConfidenceAction } from "@/lib/actions/confidence";
import { Button } from "@/components/ui/button";
import { formatConfidence, formatSignedConfidence, formatWait, confidenceLabel } from "@/lib/confidence/format";

/**
 * The Daily Claim. An ACTIVE action: nothing is granted automatically. Shown only while the Member is below the baseline; while the rolling interval has not passed it says exactly how long is left (a real
 * duration from the last claim — never "tomorrow", because eligibility is not calendar-based). Each attempt carries its own idempotency key, so a double-click or a retry can never claim twice.
 */
export function ClaimPanel({ initialTotal, canClaim, claimAmount, nextClaimAt, atOrAboveBaseline }: { initialTotal: number; canClaim: boolean; claimAmount: number; nextClaimAt: string | null; atOrAboveBaseline: boolean }) {
  const router = useRouter();
  const [total, setTotal] = useState(initialTotal);
  const [next, setNext] = useState<string | null>(nextClaimAt);
  const [ready, setReady] = useState(canClaim);
  const [full, setFull] = useState(atOrAboveBaseline);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, startTransition] = useTransition();
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!next) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [next]);

  const waitMs = next ? new Date(next).getTime() - now : 0;
  const claimable = ready || (next !== null && waitMs <= 0 && !full);

  function claim() {
    setMessage(null);
    startTransition(async () => {
      const result = await claimDailyConfidenceAction(key.current);
      key.current = crypto.randomUUID();
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok && typeof result.total === "number") {
        setTotal(result.total);
        setReady(false);
        setNext(result.nextClaimAt ?? null);
        setNow(Date.now());
        router.refresh();
      } else if (result.outcome === "too_soon") {
        setReady(false);
        setNext(result.nextClaimAt ?? null);
      } else if (result.outcome === "at_or_above_baseline") {
        setReady(false);
        setFull(true);
      }
    });
  }

  return (
    <div className="space-y-2" data-slot="confidence-claim">
      <p className="text-2xl font-semibold text-text-primary" aria-label={confidenceLabel(total)} data-slot="confidence-total">
        <span aria-hidden="true">{formatConfidence(total)}</span>
      </p>
      {!full && claimable && (
        <Button type="button" size="sm" disabled={pending} onClick={claim} data-slot="confidence-claim-button">
          Claim {formatSignedConfidence(claimAmount)}
        </Button>
      )}
      {!full && !claimable && next && (
        <p className="text-xs text-text-secondary" data-slot="confidence-wait">
          Next Daily Claim in {formatWait(waitMs)}
        </p>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-xs font-medium text-text-primary" : "text-xs text-text-secondary"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
