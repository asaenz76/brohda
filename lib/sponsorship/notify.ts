import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";

// Minimal transactional email for sponsor operations (submitted, paid, approved, rejected, changes requested, suspended). Best effort and silent on
// failure: an email problem must never fail or roll back a commercial action. No marketing, no member notifications — a Game becoming sponsored tells
// nobody anything.
const escapeHtml = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function notifySponsorMembers(sponsorId: string, subject: string, bodyLines: string[]): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: members } = await admin.from("sponsor_users").select("user_id").eq("sponsor_id", sponsorId);
    for (const m of members ?? []) {
      const { data } = await admin.auth.admin.getUserById(m.user_id);
      const to = data.user?.email;
      if (!to) continue;
      await sendEmail({ to, subject, html: `<p>${bodyLines.map(escapeHtml).join("</p><p>")}</p>` });
    }
  } catch {
    /* never block the action */
  }
}
