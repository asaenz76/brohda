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

const VISIBILITY_LABELS: Record<string, string> = {
  VISIBLE_TO_ALL_MEMBERS: "Visible to all members",
  HIDDEN: "Hidden (link only)",
};

const PARTICIPATION_VISIBILITY_LABELS: Record<string, string> = {
  SHOW_BEFORE_ENTRY: "Before entry",
  SHOW_AFTER_ENTRY: "After entry",
  SHOW_AFTER_LOCK: "After lock",
  NEVER_SHOW: "Never",
};

interface EditPoolFormProps {
  poolId: string;
  entryFeeDollars: string;
  houseFeePercent: string;
  minTotalEntries: number;
  visibility: string;
  participationVisibility: string;
  locksAtIso: string;
  // Entry fee and Platform fee stay editable even with entries (beta
  // testing needs the fee droppable to 0% mid-pool) — lock time,
  // visibility, and distribution settings freeze once money is committed,
  // matching updatePoolAction's own check (the DB trigger is the backstop).
  hasEntries: boolean;
  // True when this pool has a tier_group_id — updatePoolAction validates
  // the new entry fee doesn't collide with a sibling tier's amount, and
  // cascades a platform-fee change to every sibling (it's meant to be
  // shared across the group, not per-tier).
  isTierGrouped?: boolean;
}

export function EditPoolForm({
  poolId,
  entryFeeDollars,
  houseFeePercent,
  minTotalEntries,
  visibility,
  participationVisibility,
  locksAtIso,
  hasEntries,
  isTierGrouped = false,
}: EditPoolFormProps) {
  const [state, formAction, pending] = useActionState(updatePoolAction, initialState);
  const [locksAtLocal, setLocksAtLocal] = useState(() => toDatetimeLocalValue(locksAtIso));

  // updatePoolSchema's locksAt is z.string().datetime(), which requires a
  // strict "Z"-suffixed ISO string — Postgres/PostgREST return timestamptz
  // as "+00:00"-offset instead, so the frozen-field case below must also
  // normalize through Date/toISOString(), not pass locksAtIso straight
  // through, or the whole update 400s with "something's missing or invalid."
  const locksAtOut = locksAtLocal ? new Date(locksAtLocal).toISOString() : "";
  const locksAtFrozen = new Date(locksAtIso).toISOString();

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="poolId" value={poolId} />
      {hasEntries && (
        <p className="text-sm text-text-secondary">
          This pool already has entries — only the entry fee and Platform fee can still change.
        </p>
      )}
      {isTierGrouped && (
        <p className="text-sm text-text-secondary">
          This pool is part of a fee-tier group — its entry fee must stay unique among its siblings, and changing
          the Platform fee here applies to every tier in the group, not just this one.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="entryFee">Entry fee ($)</Label>
          <Input id="entryFee" name="entryFee" defaultValue={entryFeeDollars} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="houseFeePercent">Platform fee (%)</Label>
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
          {hasEntries ? (
            <p className="flex h-9 items-center text-sm text-text-secondary">
              {new Date(locksAtIso).toLocaleString()}
            </p>
          ) : (
            <Input
              id="locksAt"
              type="datetime-local"
              value={locksAtLocal}
              onChange={(e) => setLocksAtLocal(e.target.value)}
              required
            />
          )}
          <input type="hidden" name="locksAt" value={hasEntries ? locksAtFrozen : locksAtOut} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="visibility">Visibility</Label>
          {hasEntries ? (
            <p className="flex h-9 items-center text-sm text-text-secondary">
              {VISIBILITY_LABELS[visibility] ?? visibility}
            </p>
          ) : (
            <select
              id="visibility"
              name="visibility"
              className={SELECT_CLASS}
              defaultValue={visibility}
            >
              <option value="VISIBLE_TO_ALL_MEMBERS">Visible to all members</option>
              <option value="HIDDEN">Hidden (link only)</option>
            </select>
          )}
          {hasEntries && <input type="hidden" name="visibility" value={visibility} />}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="participationVisibility">Show distribution</Label>
          {hasEntries ? (
            <p className="flex h-9 items-center text-sm text-text-secondary">
              {PARTICIPATION_VISIBILITY_LABELS[participationVisibility] ?? participationVisibility}
            </p>
          ) : (
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
          )}
          {hasEntries && (
            <input
              type="hidden"
              name="participationVisibility"
              value={participationVisibility}
            />
          )}
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
