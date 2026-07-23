"use client";

import { useActionState, useState } from "react";
import { createInvitationAction, type CreateInvitationState } from "@/lib/actions/invitations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: CreateInvitationState = { error: null, inviteUrl: null };

export function InviteForm() {
  const [state, formAction, pending] = useActionState(createInvitationAction, initialState);
  const [copied, setCopied] = useState(false);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <form action={formAction} className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="email">Invite a friend</Label>
            <Input id="email" name="email" type="email" required placeholder="friend@example.com" />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create invite"}
          </Button>
        </form>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        {state.inviteUrl && (
          <div className="flex items-center gap-2 rounded-lg bg-surface-secondary p-2 text-sm">
            <code className="flex-1 truncate text-text-secondary">{state.inviteUrl}</code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(state.inviteUrl!);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
