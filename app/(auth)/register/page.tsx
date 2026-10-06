import Link from "next/link";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { RegisterForm } from "./register-form";
import { loginHrefFor, sanitizeNextPath } from "@/lib/auth/safe-next";
import { Card, CardContent } from "@/components/ui/card";

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const enabled = await getRegistrationEnabled();
  const rawNext = (await searchParams).next;
  // A sign-up prompt on a page (e.g. a Pick) returns the new member to that page; only a safe internal path is ever honoured.
  const next = sanitizeNextPath(Array.isArray(rawNext) ? rawNext[0] : rawNext);

  if (!enabled) {
    return (
      <Card>
        <CardContent className="space-y-4 pt-6 text-center">
          <p className="text-sm text-text-secondary">
            Registration is currently closed. Ask an admin for an invitation, or check back later.
          </p>
          <Link href="/login" className="text-sm underline underline-offset-4">
            Back to login
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <RegisterForm next={next} />
      <p className="text-center text-sm text-text-secondary">
        Already have an account?{" "}
        <Link href={loginHrefFor(next)} className="underline underline-offset-4">
          Log in
        </Link>
      </p>
    </div>
  );
}
