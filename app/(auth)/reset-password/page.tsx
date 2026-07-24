import { RequestResetForm } from "./request-reset-form";
import { SetNewPasswordForm } from "./set-new-password-form";

// The PKCE `code` is exchanged for a session inside setNewPasswordAction —
// not here — because exchangeCodeForSession is a one-time-use operation.
// Doing it as a side effect of this page merely being requested meant any
// GET to this URL before the user's own click (email link-scanners, link
// previews, etc.) silently burned the code, leaving the real click with a
// dead one. Exchanging it only when the user submits the form ties it to
// an actual user action instead of an incidental page load.
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  if (code) {
    return <SetNewPasswordForm code={code} />;
  }

  return <RequestResetForm />;
}
