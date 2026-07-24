"use client";

import { useActionState } from "react";
import { setNewPasswordAction, type SetNewPasswordState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";

const initialState: SetNewPasswordState = { error: null };

export function SetNewPasswordForm({ code }: { code: string }) {
  const [state, formAction, pending] = useActionState(setNewPasswordAction, initialState);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="code" value={code} />
          <div className="space-y-1.5">
            <Label htmlFor="password">New password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}{" "}
              <Link href="/reset-password" className="underline">
                Request a new link
              </Link>
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Saving…" : "Set new password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
