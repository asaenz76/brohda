"use client";

import { Suspense, useActionState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { loginAction, type LoginState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: LoginState = { error: null };

// useSearchParams() (for the post-account-closure "closed" banner) needs a
// Suspense boundary or `next build`'s static prerender of this page fails —
// split out so the boundary can wrap just this piece.
function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const searchParams = useSearchParams();
  const justClosed = searchParams.get("closed") === "1";

  return (
    <Card>
      <CardContent className="pt-6">
        {justClosed && (
          <p className="mb-4 rounded-lg bg-surface-secondary p-3 text-sm text-text-secondary">
            Your account has been closed.
          </p>
        )}
        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Logging in…" : "Log in"}
          </Button>
        </form>
        <div className="mt-4 space-y-2 text-center text-sm text-text-secondary">
          <p>
            <Link href="/reset-password" className="underline underline-offset-4">
              Forgot your password?
            </Link>
          </p>
          <p>
            New here?{" "}
            <Link href="/register" className="underline underline-offset-4">
              Create an account
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<Card><CardContent className="pt-6" /></Card>}>
      <LoginForm />
    </Suspense>
  );
}
