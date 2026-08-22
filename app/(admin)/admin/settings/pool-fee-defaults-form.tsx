"use client";

import { useState, useTransition } from "react";
import { setPoolFeeDefaultsAction } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PoolFeeDefaultsForm({
  initialEntryFee,
  initialHouseFeePercent,
  initialTierEntryFees,
}: {
  initialEntryFee: string;
  initialHouseFeePercent: string;
  initialTierEntryFees: string[];
}) {
  const [entryFee, setEntryFee] = useState(initialEntryFee);
  const [houseFeePercent, setHouseFeePercent] = useState(initialHouseFeePercent);
  const [tierEntryFees, setTierEntryFees] = useState(initialTierEntryFees);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  function updateTierEntryFee(index: number, value: string) {
    setTierEntryFees((prev) => prev.map((fee, i) => (i === index ? value : fee)));
  }

  function handleSave() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      const result = await setPoolFeeDefaultsAction(entryFee, houseFeePercent, tierEntryFees);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setSuccess(true);
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-text-primary">Pool fee defaults</p>
        <p className="text-xs text-text-muted">
          Pre-fills the entry fee and platform fee every time a new pool is created — still
          editable per pool, just not retyped from scratch each time.
        </p>
      </div>
      <div className="flex gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="defaultEntryFee">Entry fee ($)</Label>
          <Input
            id="defaultEntryFee"
            value={entryFee}
            onChange={(e) => setEntryFee(e.target.value)}
            placeholder="5.00"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="defaultHouseFeePercent">Platform fee (%)</Label>
          <Input
            id="defaultHouseFeePercent"
            value={houseFeePercent}
            onChange={(e) => setHouseFeePercent(e.target.value)}
            placeholder="5"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Multiple entry fee defaults ($)</Label>
        <p className="text-xs text-text-muted">
          Pre-fills the five tier amounts when an admin picks &quot;Tiered&quot; while creating a pool
          — still editable per pool, just not retyped from scratch each time.
        </p>
        <div className="flex flex-wrap gap-2">
          {tierEntryFees.map((fee, index) => (
            <Input
              key={index}
              value={fee}
              onChange={(e) => updateTierEntryFee(index, e.target.value)}
              aria-label={`Default tier ${index + 1} entry fee`}
              className="w-24"
            />
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm font-medium text-text-primary">Defaults saved.</p>}
      <Button type="button" disabled={isPending} onClick={handleSave}>
        {isPending ? "Saving…" : "Save defaults"}
      </Button>
    </div>
  );
}
