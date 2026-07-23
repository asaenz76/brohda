"use client";

import { useActionState, useState } from "react";
import { gradeComboLegsAction, type GradeComboState } from "@/lib/actions/pool-combo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

const initialState: GradeComboState = { error: null };

export function ComboLegGradingForm({
  poolId,
  legs,
}: {
  poolId: string;
  legs: Array<{ id: string; label: string; isMet: boolean | null; didNotPlay: boolean }>;
}) {
  const [state, formAction, pending] = useActionState(gradeComboLegsAction, initialState);
  const [dnpLegs, setDnpLegs] = useState<Set<string>>(
    () => new Set(legs.filter((leg) => leg.didNotPlay).map((leg) => leg.id)),
  );

  function toggleDnp(legId: string, checked: boolean) {
    setDnpLegs((prev) => {
      const next = new Set(prev);
      if (checked) next.add(legId);
      else next.delete(legId);
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="poolId" value={poolId} />
      <p className="text-sm text-text-secondary">
        Mark each condition. &ldquo;Yes&rdquo; only wins if every condition is met — otherwise
        &ldquo;No&rdquo; wins. If nobody picked the graded side, entries are refunded in full, no
        fee taken. If a featured player never took the pitch, mark &ldquo;Did not play&rdquo;
        instead — that voids the whole pool and refunds everyone in full, no fee taken, no matter
        how the other conditions graded or who picked correctly. Nothing is final yet — the next
        screen shows exactly what confirming will do before any money moves.
      </p>
      <div className="space-y-3">
        {legs.map((leg) => {
          const isDnp = dnpLegs.has(leg.id);
          return (
            <div key={leg.id} className="space-y-1 rounded-lg border border-border-subtle p-2.5">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`leg_${leg.id}`}
                  name={`leg_${leg.id}`}
                  defaultChecked={leg.isMet ?? false}
                  disabled={isDnp}
                />
                <Label htmlFor={`leg_${leg.id}`} className="text-sm font-normal text-text-secondary">
                  {leg.label}
                </Label>
              </div>
              <div className="flex items-center gap-2 pl-0.5">
                <Checkbox
                  id={`dnp_${leg.id}`}
                  name={`dnp_${leg.id}`}
                  defaultChecked={leg.didNotPlay}
                  onCheckedChange={(checked) => toggleDnp(leg.id, checked)}
                />
                <Label htmlFor={`dnp_${leg.id}`} className="text-xs font-normal text-text-muted">
                  Did not play (voids the whole pool)
                </Label>
              </div>
            </div>
          );
        })}
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Grading…" : "Grade Combo"}
      </Button>
    </form>
  );
}
