"use client";

import { useActionState } from "react";
import { addCohortMemberAction, createCohortAction, removeCohortMemberAction, setCohortEnabledAction, type ActionResult } from "@/lib/actions/execution-operations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: ActionResult = { success: false, error: null };

export function CreateCohortForm() {
  const [state, formAction, pending] = useActionState(createCohortAction, initialState);
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm font-semibold text-text-primary">Create a rollout cohort</p>
        <form action={formAction} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="key">Key</Label>
            <Input id="key" name="key" placeholder="internal-testers" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" placeholder="Internal testers" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mode">Mode</Label>
            <select id="mode" name="mode" required className="w-full rounded-md border border-border-subtle bg-surface-primary px-3 py-2 text-sm">
              <option value="ALLOWLIST">ALLOWLIST (explicit members)</option>
              <option value="PERCENTAGE">PERCENTAGE (deterministic)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="percentage">Percentage (PERCENTAGE mode only)</Label>
            <Input id="percentage" name="percentage" type="number" min={0} max={100} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="rolloutSeed">Rollout seed (PERCENTAGE mode only)</Label>
            <Input id="rolloutSeed" name="rolloutSeed" placeholder="a stable string — never randomized per request" />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create cohort"}
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

export function CohortEnabledToggleButton({ id, enabled }: { id: string; enabled: boolean }) {
  const [state, formAction, pending] = useActionState(setCohortEnabledAction, initialState);
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

export function CohortMembershipForm({ cohortId }: { cohortId: string }) {
  const [addState, addAction, addPending] = useActionState(addCohortMemberAction, initialState);
  const [removeState, removeAction, removePending] = useActionState(removeCohortMemberAction, initialState);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <form action={addAction} className="flex items-center gap-2">
        <input type="hidden" name="cohortId" value={cohortId} />
        <Input name="userId" placeholder="user id" className="h-8 w-48" />
        <Button type="submit" size="sm" disabled={addPending}>
          {addPending ? "Adding…" : "Add member"}
        </Button>
      </form>
      <form action={removeAction} className="flex items-center gap-2">
        <input type="hidden" name="cohortId" value={cohortId} />
        <Input name="userId" placeholder="user id" className="h-8 w-48" />
        <Button type="submit" size="sm" variant="outline" disabled={removePending}>
          {removePending ? "Removing…" : "Remove member"}
        </Button>
      </form>
      {(addState.error || removeState.error) && <span className="text-xs text-danger">{addState.error ?? removeState.error}</span>}
    </div>
  );
}
