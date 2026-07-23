import { createClient } from "@/lib/supabase/server";
import { RequestResetForm } from "./request-reset-form";
import { SetNewPasswordForm } from "./set-new-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return <SetNewPasswordForm />;
    }
  }

  return <RequestResetForm />;
}
