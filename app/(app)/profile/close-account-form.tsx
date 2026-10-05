"use client";

import { useActionState, useState } from "react";
import { closeAccountAction, type CloseAccountState } from "@/lib/actions/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: CloseAccountState = { error: null };

// `showMoney` follows the consumer money capability: the balance and funding-request conditions are only mentioned to someone for whom the
// wallet is visible, so a free-only account is never told about money it can't see.
export function CloseAccountForm({ showMoney }: { showMoney: boolean }) {
  const [state, formAction, pending] = useActionState(closeAccountAction, initialState);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="outline" className="w-full text-danger" onClick={() => setOpen(true)}>
        Close account
      </Button>
    );
  }

  return (
    <Card className="border-danger/50">
      <CardContent className="space-y-3 pt-6">
        <p className="text-sm font-semibold text-text-primary">Close your account?</p>
        <p className="text-sm text-text-secondary">
          This deactivates your account and permanently removes your name, username, and photo —
          this can&apos;t be undone. Your email can never be used to register again.{" "}
          {showMoney
            ? "You\u2019ll need a $0 balance and no picks still in progress, and any pending deposit or withdrawal request must be resolved first."
            : "You\u2019ll need no picks still in progress."}
        </p>
        <form action={formAction} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="confirmation">Type CLOSE to confirm</Label>
            <Input id="confirmation" name="confirmation" placeholder="CLOSE" required />
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Closing…" : "Permanently close account"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
