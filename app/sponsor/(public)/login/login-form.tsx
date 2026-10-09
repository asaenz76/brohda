"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { resendSponsorVerificationAction, sponsorLoginAction, type SponsorLoginState } from "@/lib/actions/sponsor-account";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: SponsorLoginState = { error: null };

export function SponsorLoginForm({ next, verified }: { next: string | null; verified: boolean }) {
  const [state, formAction, pending] = useActionState(sponsorLoginAction, initialState);
  const [email, setEmail] = useState("");
  const [resent, setResent] = useState(false);
  const safeNext = sanitizeNextPath(next);

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-4 text-base font-semibold text-text-primary">Sponsor log in</h2>
        {verified && (
          <p role="status" className="mb-4 rounded-lg bg-surface-secondary p-3 text-sm text-text-secondary">
            Your email is verified. Log in to see where your application stands.
          </p>
        )}
        <form action={formAction} className="space-y-4">
          {safeNext && <input type="hidden" name="next" value={safeNext} />}
          <div className="space-y-1.5">
            <Label htmlFor="email">Business email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <PasswordInput id="password" name="password" autoComplete="current-password" required />
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
          {state.error && email && (
            <p>
              <button
                type="button"
                className="underline underline-offset-4"
                disabled={resent}
                onClick={async () => {
                  await resendSponsorVerificationAction(email);
                  setResent(true);
                }}
              >
                {resent ? "If that address has an application, we sent a new verification email." : "Resend the verification email"}
              </button>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
