import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildPoolPublishedEmail, sendEmail } from "./resend";

// Fires when an admin publishes a pool (DRAFT -> OPEN). Emails every
// active player who hasn't opted out — never admins/super_admins (they
// coordinate pools, they don't enter them), and never for a HIDDEN
// (link-only) pool, since blasting an invite-only pool to everyone would
// defeat the point of hiding it.
export async function notifyPoolPublished(pool: {
  id: string;
  question: string;
  visibility: string;
}): Promise<void> {
  if (pool.visibility !== "VISIBLE_TO_ALL_MEMBERS") return;
  if (!process.env.RESEND_API_KEY) return;

  const admin = createAdminClient();

  const { data: recipients } = await admin
    .from("user_profiles")
    .select("id")
    .eq("role", "player")
    .eq("is_active", true)
    .eq("email_notifications_enabled", true);

  if (!recipients || recipients.length === 0) return;

  const recipientIds = new Set(recipients.map((r) => r.id as string));

  // auth.admin.listUsers() is the only way to read email addresses from
  // this client — it returns every user, not just the ids we asked for,
  // so the filtering happens here rather than in the query above.
  const { data: userList } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const emails = (userList?.users ?? [])
    .filter((u) => recipientIds.has(u.id) && u.email)
    .map((u) => u.email as string);

  if (emails.length === 0) return;

  const poolUrl = `${process.env.APP_URL}/pool/${pool.id}`;
  const { subject, html } = buildPoolPublishedEmail(pool.question, poolUrl);

  await Promise.all(emails.map((to) => sendEmail({ to, subject, html })));
}
