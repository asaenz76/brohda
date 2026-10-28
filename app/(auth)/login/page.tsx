import { LoginPageForm } from "./login-form";
import { AuthGameContext } from "@/components/auth/AuthGameContext";
import { sanitizeNextPath } from "@/lib/auth/safe-next";

// The log-in screen. A server page so it can name the Game a visitor came to Pick (M7); the form itself is the same client form as before.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next;
  const next = sanitizeNextPath(Array.isArray(raw) ? raw[0] : raw);
  return (
    <>
      <AuthGameContext next={next} action="login" />
      <LoginPageForm />
    </>
  );
}
