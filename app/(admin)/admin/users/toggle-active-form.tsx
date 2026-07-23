"use client";

import { useActionState, useState } from "react";
import { setUserActiveAction, type SetUserActiveState } from "@/lib/actions/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const initialState: SetUserActiveState = { error: null };

/**
 * Give this a `key` tied to `isActive` from the parent list. Once the action
 * succeeds, `revalidatePath` refreshes the server data with a flipped
 * `isActive`, which changes the key and remounts this component with local
 * `open` state reset — no effect needed to "close the form on success".
 */
export function ToggleActiveForm({ userId, isActive }: { userId: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(setUserActiveAction, initialState);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {isActive ? "Deactivate" : "Activate"}
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="isActive" value={(!isActive).toString()} />
      <Input
        name="reason"
        placeholder="Reason (required)"
        required
        className="h-8 w-40 text-xs"
      />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Confirm"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
