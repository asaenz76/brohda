"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import { registerAction, type RegisterState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";

const initialState: RegisterState = { error: null };

// One field per step, submitted together as a single form on the last
// step — collecting these one at a time (rather than the old single
// 3-field form) means username is set atomically at account creation
// instead of via a separate forced "complete your profile" redirect
// afterward, which testers weren't noticing and got stuck on.
const STEPS = ["displayName", "email", "password", "username"] as const;
type Step = (typeof STEPS)[number];

const STEP_COPY: Record<Step, { label: string; helper?: string }> = {
  displayName: { label: "What should we call you?" },
  email: { label: "What's your email?" },
  password: { label: "Choose a password" },
  username: {
    label: "Pick a username",
    helper: "This is permanent — it can't be changed later, so choose carefully.",
  },
};

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(registerAction, initialState);
  const [stepIndex, setStepIndex] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const step = STEPS[stepIndex];
  const isLastStep = stepIndex === STEPS.length - 1;

  // A submit failure (email already registered, username taken) is only
  // ever discoverable server-side, at the final step's submit — jump back
  // there so the error sits next to the submit button again, same pattern
  // as SocialPoolCard's SSR-fingerprint reset (compare-during-render, not
  // an effect, so there's no extra render for this to show up a beat late).
  if (state.error && stepIndex !== STEPS.length - 1) {
    setStepIndex(STEPS.length - 1);
  }

  function goNext() {
    const form = formRef.current;
    const field = form?.elements.namedItem(step);
    if (field instanceof HTMLInputElement && !field.reportValidity()) return;
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="mb-5 flex items-center gap-1.5" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={
                i <= stepIndex
                  ? "h-1.5 flex-1 rounded-full bg-accent-primary"
                  : "h-1.5 flex-1 rounded-full bg-surface-secondary"
              }
            />
          ))}
        </div>

        <form
          ref={formRef}
          action={formAction}
          className="space-y-4"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isLastStep) {
              e.preventDefault();
              goNext();
            }
          }}
        >
          <div className={step === "displayName" ? "space-y-1.5" : "hidden"}>
            <Label htmlFor="displayName">{STEP_COPY.displayName.label}</Label>
            <Input id="displayName" name="displayName" required maxLength={60} autoFocus={step === "displayName"} />
          </div>

          <div className={step === "email" ? "space-y-1.5" : "hidden"}>
            <Label htmlFor="email">{STEP_COPY.email.label}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus={step === "email"}
            />
          </div>

          <div className={step === "password" ? "space-y-1.5" : "hidden"}>
            <Label htmlFor="password">{STEP_COPY.password.label}</Label>
            <PasswordInput
              id="password"
              name="password"
              autoComplete="new-password"
              minLength={8}
              required
              autoFocus={step === "password"}
            />
          </div>

          <div className={step === "username" ? "space-y-1.5" : "hidden"}>
            <Label htmlFor="username">{STEP_COPY.username.label}</Label>
            <Input
              id="username"
              name="username"
              maxLength={24}
              minLength={3}
              pattern="[a-zA-Z0-9_]+"
              placeholder="Letters, numbers, or underscores"
              required
              autoFocus={step === "username"}
            />
            <p className="text-xs text-text-secondary">{STEP_COPY.username.helper}</p>
          </div>

          {isLastStep && (
            <div className="flex items-start gap-2">
              <Checkbox id="acceptedTerms" name="acceptedTerms" required className="mt-0.5" />
              <Label htmlFor="acceptedTerms" className="text-xs font-normal text-text-secondary">
                I have read and agree to the{" "}
                <Link href="/terms" target="_blank" className="underline underline-offset-4">
                  Terms of Service
                </Link>{" "}
                and{" "}
                <Link href="/privacy" target="_blank" className="underline underline-offset-4">
                  Privacy Policy
                </Link>
                .
              </Label>
            </div>
          )}

          {state.error && (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          )}

          <div className="flex gap-2">
            {stepIndex > 0 && (
              <Button type="button" variant="outline" onClick={goBack} disabled={pending}>
                Back
              </Button>
            )}
            {isLastStep ? (
              <Button type="submit" className="flex-1" disabled={pending}>
                {pending ? (
                  "Creating account…"
                ) : (
                  <>
                    Join <span className="italic">brohda.</span>
                  </>
                )}
              </Button>
            ) : (
              <Button type="button" className="flex-1" onClick={goNext}>
                Continue
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
