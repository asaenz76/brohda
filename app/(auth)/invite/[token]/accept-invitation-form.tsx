"use client";

import Link from "next/link";
import { useActionState } from "react";
import { acceptInvitationAction, type AcceptInvitationState } from "@/lib/actions/invitations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";

const initialState: AcceptInvitationState = { error: null };

export function AcceptInvitationForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, pending] = useActionState(acceptInvitationAction, initialState);

  return (
    <Card>
      <CardContent className="pt-6">
        <p className="mb-4 text-sm text-text-secondary">
          Setting up an account for <span className="text-text-primary">{email}</span>
        </p>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <div className="space-y-1.5">
            <Label htmlFor="displayName">Display name</Label>
            <Input id="displayName" name="displayName" required maxLength={60} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="acceptedRules" name="acceptedRules" required />
            <Label htmlFor="acceptedRules" className="text-sm font-normal text-text-secondary">
              I accept the community rules, and the{" "}
              <Link href="/terms" target="_blank" className="underline underline-offset-4">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="underline underline-offset-4">
                Privacy Policy
              </Link>
              , for this pool platform.
            </Label>
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Creating account…" : (
              <>
                Join <span className="italic">brohda.</span>
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
