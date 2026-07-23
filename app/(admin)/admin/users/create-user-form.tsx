"use client";

import { useActionState, useState } from "react";
import { createUserManuallyAction, type CreateUserManuallyState } from "@/lib/actions/users";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: CreateUserManuallyState = { error: null, credentials: null };

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createUserManuallyAction, initialState);
  const [copied, setCopied] = useState(false);

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <form action={formAction} className="space-y-2">
          <div className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="createUserDisplayName">Create an account manually</Label>
              <Input
                id="createUserDisplayName"
                name="displayName"
                required
                placeholder="Display name"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="createUserEmail" className="sr-only">
                Email
              </Label>
              <Input
                id="createUserEmail"
                name="email"
                type="email"
                required
                placeholder="friend@example.com"
              />
            </div>
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create account"}
          </Button>
        </form>
        {state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        {state.credentials && (
          <div className="space-y-1 rounded-lg bg-surface-secondary p-2 text-sm">
            <p className="text-xs text-text-muted">
              Share these with them — this password won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate text-text-secondary">
                {state.credentials.email} / {state.credentials.password}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(
                    `${state.credentials!.email} / ${state.credentials!.password}`,
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
