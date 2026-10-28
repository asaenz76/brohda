"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { registerAction, type RegisterState } from "@/lib/actions/auth";
import { loginHrefFor } from "@/lib/auth/safe-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";

const initialState: RegisterState = { error: null };

type FieldId = "email" | "password" | "username" | "acceptedTerms";
const FIELD_ORDER: FieldId[] = ["email", "password", "username", "acceptedTerms"];
// The generic danger red (#ef4444) is 3.8:1 on white — too faint for small error text (WCAG AA needs 4.5:1), so errors here use a darker red in light mode.
const ERROR_TEXT = "text-red-700 dark:text-danger";

/**
 * Sign-up on ONE screen: email, password, username, Terms — one submission creates the account. (It used to be four screens of one field each; a single failed submit — a taken username, an email that already had an account — wiped every field and
 * left three required ones hidden, so the only way forward was Back, Back, Back and typing it all again.) The values live in this component, not in the DOM, so a failed attempt keeps everything the person typed, the password included (it never
 * leaves this tab's memory except in the one POST). The Game the visitor came for travels in `next`.
 */
export function RegisterForm({ next = null }: { next?: string | null }) {
  const [state, formAction, pending] = useActionState(registerAction, initialState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [accepted, setAccepted] = useState(false);
  const fieldErrors = state.fieldErrors ?? {};

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const termsRef = useRef<HTMLButtonElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);

  // After a rejected submit, put the cursor on the first field that needs attention (or announce a problem that belongs to no field).
  useEffect(() => {
    if (state === initialState) return;
    const refs: Record<FieldId, { focus: () => void } | null> = { email: emailRef.current, password: passwordRef.current, username: usernameRef.current, acceptedTerms: termsRef.current };
    const first = FIELD_ORDER.find((id) => state.fieldErrors?.[id]);
    if (first) refs[first]?.focus();
    else alertRef.current?.focus();
  }, [state]);

  const describe = (id: FieldId, extra?: string) => [fieldErrors[id] ? `${id}-error` : null, extra].filter(Boolean).join(" ") || undefined;

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          {next && <input type="hidden" name="next" value={next} />}

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={fieldErrors.email ? true : undefined}
              aria-describedby={describe("email")}
            />
            {fieldErrors.email && (
              <p id="email-error" className={`text-xs ${ERROR_TEXT}`}>
                {fieldErrors.email}
                {state.existingAccount && (
                  <>
                    {" "}
                    <Link href={loginHrefFor(next)} className="font-medium underline underline-offset-4">
                      Log in instead
                    </Link>
                  </>
                )}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              ref={passwordRef}
              id="password"
              name="password"
              autoComplete="new-password"
              enterKeyHint="next"
              minLength={8}
              maxLength={72}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={describe("password", "password-hint")}
            />
            <p id="password-hint" className="text-xs text-text-secondary">
              At least 8 characters.
            </p>
            {fieldErrors.password && (
              <p id="password-error" className={`text-xs ${ERROR_TEXT}`}>
                {fieldErrors.password}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              ref={usernameRef}
              id="username"
              name="username"
              autoComplete="nickname"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              maxLength={24}
              minLength={3}
              pattern="[a-zA-Z0-9_]+"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={describe("username", "username-hint")}
            />
            <p id="username-hint" className="text-xs text-text-secondary">
              Letters, numbers or underscores. Permanent, so choose carefully.
            </p>
            {fieldErrors.username && (
              <p id="username-error" className={`text-xs ${ERROR_TEXT}`}>
                {fieldErrors.username}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-start gap-2">
              <Checkbox
                ref={termsRef}
                id="acceptedTerms"
                name="acceptedTerms"
                required
                className="mt-0.5"
                checked={accepted}
                onCheckedChange={(checked) => setAccepted(checked === true)}
                // The id lands on the hidden input, so the <label for> does not name the checkbox a screen reader reaches; name it directly.
                aria-labelledby="acceptedTerms-label"
                aria-invalid={fieldErrors.acceptedTerms ? true : undefined}
                aria-describedby={describe("acceptedTerms")}
              />
              <Label id="acceptedTerms-label" htmlFor="acceptedTerms" className="block text-xs font-normal leading-snug text-text-secondary">
                I have read and agree to the{" "}
                <Link href="/terms" target="_blank" className="underline underline-offset-4">
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy" target="_blank" className="underline underline-offset-4">
                  Policy
                </Link>
                .
              </Label>
            </div>
            {fieldErrors.acceptedTerms && (
              <p id="acceptedTerms-error" className={`text-xs ${ERROR_TEXT}`}>
                {fieldErrors.acceptedTerms}
              </p>
            )}
          </div>

          {state.error && (
            <p ref={alertRef} tabIndex={-1} role="alert" className={`text-sm ${ERROR_TEXT} outline-none`}>
              {state.error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? (
              "Creating account…"
            ) : (
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
