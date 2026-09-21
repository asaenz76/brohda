"use client";

import { useActionState } from "react";
import { createLimitAction, setLimitEnabledAction, setProviderOverrideAction, type ActionResult } from "@/lib/actions/execution-operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: ActionResult = { success: false, error: null };

export function CreateLimitForm() {
  const [state, formAction, pending] = useActionState(createLimitAction, initialState);
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm font-semibold text-text-primary">Add an execution limit</p>
        <form action={formAction} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="limit-scope">Scope</Label>
            <select id="limit-scope" name="scope" required className="w-full rounded-md border border-border-subtle bg-surface-primary px-3 py-2 text-sm">
              <option value="GLOBAL">GLOBAL</option>
              <option value="USER">USER</option>
              <option value="COHORT">COHORT</option>
              <option value="JURISDICTION">JURISDICTION</option>
              <option value="PROVIDER">PROVIDER</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="limit-target">Target (blank for GLOBAL)</Label>
            <Input id="limit-target" name="target" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="limitType">Limit type</Label>
            <select id="limitType" name="limitType" required className="w-full rounded-md border border-border-subtle bg-surface-primary px-3 py-2 text-sm">
              <option value="PER_ORDER_AMOUNT_CENTS">Per-order amount (cents)</option>
              <option value="DAILY_AMOUNT_CENTS">Daily amount (cents)</option>
              <option value="ROLLING_AMOUNT_CENTS">Rolling amount (cents)</option>
              <option value="DAILY_ORDER_COUNT">Daily order count</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="thresholdValue">Threshold</Label>
            <Input id="thresholdValue" name="thresholdValue" type="number" min={1} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="windowSeconds">Window seconds (ROLLING only)</Label>
            <Input id="windowSeconds" name="windowSeconds" type="number" min={1} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add limit"}
            </Button>
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger sm:col-span-2">
              {state.error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function LimitEnabledToggleButton({ id, enabled }: { id: string; enabled: boolean }) {
  const [state, formAction, pending] = useActionState(setLimitEnabledAction, initialState);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : enabled ? "Disable" : "Enable"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}

export function ProviderOverrideForm({ provider, manuallyDisabled }: { provider: string; manuallyDisabled: boolean }) {
  const [state, formAction, pending] = useActionState(setProviderOverrideAction, initialState);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="disabled" value={String(!manuallyDisabled)} />
      {!manuallyDisabled && <Input name="reason" placeholder="Reason for manual disable" className="h-8 w-56" required />}
      <Button type="submit" size="sm" variant={manuallyDisabled ? "outline" : "destructive"} disabled={pending}>
        {pending ? "Saving…" : manuallyDisabled ? "Re-enable provider" : "Manually disable"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
