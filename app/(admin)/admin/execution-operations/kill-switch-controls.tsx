"use client";

import { useActionState } from "react";
import { createKillSwitchAction, disableKillSwitchAction, type ActionResult } from "@/lib/actions/execution-operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: ActionResult = { success: false, error: null };

// Milestone 5.5 (STEP 7) — the operator-facing kill-switch form. Every
// field maps directly to a column on execution_kill_switches; nothing here
// hard-codes a scope/target vocabulary beyond the closed scope list
// itself, which is a true invariant (lib/execution/types.ts's own comment).
export function CreateKillSwitchForm() {
  const [state, formAction, pending] = useActionState(createKillSwitchAction, initialState);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm font-semibold text-text-primary">Activate a kill switch</p>
        <form action={formAction} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="scope">Scope</Label>
            <select id="scope" name="scope" required className="w-full rounded-md border border-border-subtle bg-surface-primary px-3 py-2 text-sm">
              <option value="GLOBAL">GLOBAL</option>
              <option value="PROVIDER">PROVIDER</option>
              <option value="JURISDICTION">JURISDICTION</option>
              <option value="MARKET">MARKET</option>
              <option value="USER">USER</option>
              <option value="COHORT">COHORT</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="target">Target (blank for GLOBAL)</Label>
            <Input id="target" name="target" placeholder="provider name, market id, user id, or cohort key" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" name="reason" placeholder="Why is this switch being activated?" required />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="note">Internal note (optional)</Label>
            <Input id="note" name="note" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="expiresAt">Expires at (optional)</Label>
            <Input id="expiresAt" name="expiresAt" type="datetime-local" />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={pending} variant="destructive">
              {pending ? "Activating…" : "Activate switch"}
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

export function DisableKillSwitchButton({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(disableKillSwitchAction, initialState);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Disabling…" : "Disable"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
