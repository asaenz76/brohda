import "server-only";

const RESEND_API_URL = "https://api.resend.com/emails";
// Same verified domain the Supabase Auth SMTP relay already sends from
// (see docs/DEPLOYMENT.md) — a distinct address so these read as app
// notifications, not password-reset/auth mail.
const FROM_ADDRESS = "brohda. <notifications@brohda.com>";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

// No-ops (rather than throwing) whenever RESEND_API_KEY isn't set — mirrors
// API_FOOTBALL_ENABLED's pattern elsewhere, so local dev/CI need no real
// key. Swallows delivery errors too: a failed email must never fail the
// server action that triggered it (e.g. publishing a pool).
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });

    if (!response.ok) {
      console.error("Resend email send failed", response.status, await response.text());
    }
  } catch (error) {
    console.error("Resend email send failed", error);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildPoolPublishedEmail(question: string, poolUrl: string): { subject: string; html: string } {
  const safeQuestion = escapeHtml(question);
  return {
    subject: `New pool: ${question}`,
    html: `
      <p>A new pool just went up:</p>
      <p><strong>${safeQuestion}</strong></p>
      <p><a href="${poolUrl}">View and enter</a></p>
    `.trim(),
  };
}
