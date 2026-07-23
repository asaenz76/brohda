"use client";

import { useActionState, useState } from "react";
import { setUserRoleAction, type SetUserRoleState } from "@/lib/actions/users";
import { Button } from "@/components/ui/button";

const initialState: SetUserRoleState = { error: null };

/**
 * Same remount-on-success shape as ToggleActiveForm — key this on `role`
 * from the parent list so a successful change resets local `open` state.
 */
export function SetRoleForm({ userId, role }: { userId: string; role: "player" | "admin" }) {
  const [state, formAction, pending] = useActionState(setUserRoleAction, initialState);
  const [open, setOpen] = useState(false);
  const nextRole = role === "player" ? "admin" : "player";

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {role === "player" ? "Make admin" : "Remove admin"}
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="role" value={nextRole} />
      <span className="text-xs text-text-secondary">Set role to {nextRole}?</span>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Confirm"}
      </Button>
      {state.error && <span className="text-xs text-danger">{state.error}</span>}
    </form>
  );
}
