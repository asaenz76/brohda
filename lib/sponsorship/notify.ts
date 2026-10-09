import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";

// Minimal transactional email for sponsor operations (submitted, paid, approved, rejected, changes requested, suspended). Best effort and silent on
// failure: an email problem must never fail or roll back a commercial action. No marketing, no member notifications — a Game becoming sponsored tells
// nobody anything.
const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function notifySponsorAccount(sponsorId: string, subject: string, bodyLines: string[]): Promise<void> {
  try {
    const admin = createAdminClient();
    // A Sponsor organization has at most one login; the email goes to that login's address.
    const { data: account } = await admin.from("sponsor_accounts").select("user_id").eq("sponsor_id", sponsorId).maybeSingle();
    if (!account) return;
    const { data } = await admin.auth.admin.getUserById(account.user_id);
    const to = data.user?.email;
    if (!to) return;
    await sendEmail({ to, subject, html: `<p>${bodyLines.map(escapeHtml).join("</p><p>")}</p>` });
  } catch {
    /* never block the action */
  }
}
