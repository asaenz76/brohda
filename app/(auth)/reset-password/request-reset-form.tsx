"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordResetAction, type RequestPasswordResetState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: RequestPasswordResetState = { sent: false, error: null };

export function RequestResetForm() {
  const [state, formAction, pending] = useActionState(requestPasswordResetAction, initialState);

  if (state.sent) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm text-text-secondary">
          If that email has an account, a reset link is on its way.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Sending…" : "Send reset link"}
          </Button>
        </form>
        <div className="mt-4 text-center text-sm text-text-secondary">
          <Link href="/login" className="underline underline-offset-4">
            Back to login
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
