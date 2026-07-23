import Link from "next/link";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { RegisterForm } from "./register-form";
import { Card, CardContent } from "@/components/ui/card";

export default async function RegisterPage() {
  const enabled = await getRegistrationEnabled();

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
      <RegisterForm />
      <p className="text-center text-sm text-text-secondary">
        Already have an account?{" "}
        <Link href="/login" className="underline underline-offset-4">
          Log in
        </Link>
      </p>
    </div>
  );
}
