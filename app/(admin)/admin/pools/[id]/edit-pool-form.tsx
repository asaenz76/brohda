"use client";

import { useActionState, useState } from "react";
import { updatePoolAction, type UpdatePoolState } from "@/lib/actions/pools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: UpdatePoolState = { error: null };
const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface EditPoolFormProps {
  poolId: string;
  entryFeeDollars: string;
  houseFeePercent: string;
  minTotalEntries: number;
  visibility: string;
  participationVisibility: string;
  locksAtIso: string;
}

// Only rendered while entry_count === 0 (fee immutability, spec §11.3) —
// the DB trigger is the real backstop either way.
export function EditPoolForm({
  poolId,
  entryFeeDollars,
  houseFeePercent,
  minTotalEntries,
  visibility,
  participationVisibility,
  locksAtIso,
}: EditPoolFormProps) {
  const [state, formAction, pending] = useActionState(updatePoolAction, initialState);
  const [locksAtLocal, setLocksAtLocal] = useState(() => toDatetimeLocalValue(locksAtIso));

  const locksAtOut = locksAtLocal ? new Date(locksAtLocal).toISOString() : "";

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="poolId" value={poolId} />
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="entryFee">Entry fee ($)</Label>
          <Input id="entryFee" name="entryFee" defaultValue={entryFeeDollars} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="houseFeePercent">Coordinator fee (%)</Label>
          <Input
            id="houseFeePercent"
            name="houseFeePercent"
            defaultValue={houseFeePercent}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Minimum entries</Label>
          {/* Fixed platform-wide, not editable here — see MINIMUM_POOL_ENTRIES
              in lib/validations/pools.ts. Pools created before that floor
              existed keep their original lower value, shown as-is. */}
          <p className="flex h-9 items-center text-sm text-text-secondary">{minTotalEntries}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="locksAt">Lock time</Label>
          <Input
            id="locksAt"
            type="datetime-local"
            value={locksAtLocal}
            onChange={(e) => setLocksAtLocal(e.target.value)}
            required
          />
          <input type="hidden" name="locksAt" value={locksAtOut} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="visibility">Visibility</Label>
          <select
            id="visibility"
            name="visibility"
            className={SELECT_CLASS}
            defaultValue={visibility}
          >
            <option value="VISIBLE_TO_ALL_MEMBERS">Visible to all members</option>
            <option value="HIDDEN">Hidden (link only)</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="participationVisibility">Show distribution</Label>
          <select
            id="participationVisibility"
            name="participationVisibility"
            className={SELECT_CLASS}
            defaultValue={participationVisibility}
          >
            <option value="SHOW_BEFORE_ENTRY">Before entry</option>
            <option value="SHOW_AFTER_ENTRY">After entry</option>
            <option value="SHOW_AFTER_LOCK">After lock</option>
            <option value="NEVER_SHOW">Never</option>
          </select>
        </div>
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
