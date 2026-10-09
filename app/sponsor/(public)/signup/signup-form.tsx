"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { resendSponsorVerificationAction, sponsorSignupAction, type SponsorSignupState } from "@/lib/actions/sponsor-account";
import type { SponsorLegalDocument } from "@/lib/sponsor/terms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const initialState: SponsorSignupState = { error: null };

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-danger">
      {message}
    </p>
  );
}

export function SponsorSignupForm({ terms }: { terms: SponsorLegalDocument | null }) {
  const [state, formAction, pending] = useActionState(sponsorSignupAction, initialState);
  const [email, setEmail] = useState("");
  const [resent, setResent] = useState(false);
  const fe = state.fieldErrors ?? {};

  if (state.sent) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6 text-center" data-slot="sponsor-check-email">
          <h2 className="text-base font-semibold text-text-primary">Check your email</h2>
          <p className="text-sm text-text-secondary">
            We sent a verification link to your business email. Open it to verify the address, then sign in to finish your profile. Brohda reviews every Sponsor application before an account can start sponsoring.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={resent}
            onClick={async () => {
              await resendSponsorVerificationAction(email);
              setResent(true);
            }}
          >
            {resent ? "Sent again" : "Resend the email"}
          </Button>
          <p className="text-sm">
            <Link href="/sponsor/login" className="underline underline-offset-4">
              Go to Sponsor log in
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <h2 className="mb-1 text-base font-semibold text-text-primary">Become a Sponsor</h2>
        <p className="mb-4 text-sm text-text-secondary">Create a Sponsor account for your business. This is separate from a Brohda Member account.</p>
        <form action={formAction} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="email">Business email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(fe.email)} />
            <FieldError message={fe.email} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <PasswordInput id="password" name="password" autoComplete="new-password" required minLength={8} maxLength={72} aria-invalid={Boolean(fe.password)} />
            <FieldError message={fe.password} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="brandName">Brand or company name</Label>
            <Input id="brandName" name="brandName" required maxLength={80} aria-invalid={Boolean(fe.brandName)} />
            <FieldError message={fe.brandName} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contactName">Contact person&apos;s name</Label>
            <Input id="contactName" name="contactName" autoComplete="name" required maxLength={120} aria-invalid={Boolean(fe.contactName)} />
            <FieldError message={fe.contactName} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="website">Website (optional)</Label>
            <Input id="website" name="website" inputMode="url" autoComplete="url" maxLength={300} placeholder="example.com" aria-invalid={Boolean(fe.website)} />
            <FieldError message={fe.website} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="country">Country (optional)</Label>
              <Input id="country" name="country" autoComplete="country-name" maxLength={80} />
              <FieldError message={fe.country} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone / WhatsApp (optional)</Label>
              <Input id="phone" name="phone" type="tel" autoComplete="tel" maxLength={40} aria-invalid={Boolean(fe.phone)} />
              <FieldError message={fe.phone} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="logo">Logo (optional)</Label>
            <input id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" className="block w-full text-sm" />
            <FieldError message={fe.logo} />
          </div>
          {terms && (
            <div className="space-y-1">
              <label className="flex items-start gap-2 text-sm text-text-secondary">
                <input type="checkbox" name="acceptedTerms" required className="mt-1" />
                <span>
                  I accept the{" "}
                  <Link href={terms.href} target="_blank" className="underline underline-offset-4">
                    Sponsor Terms
                  </Link>{" "}
                  {terms.effectiveDate ? ` (effective ${terms.effectiveDate})` : ""}.
                </span>
              </label>
              <FieldError message={fe.acceptedTerms} />
            </div>
          )}
          {state.error && !Object.keys(fe).length && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}
          {state.error && fe.email && (
            <p role="alert" className="sr-only">
              {state.error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Submitting…" : "Apply to sponsor"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
