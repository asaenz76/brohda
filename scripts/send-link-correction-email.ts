/**
 * One-time follow-up to the 15 real recipients of the beta-sunset
 * announcement (send-beta-sunset-email.ts): that email's "Add funds"
 * button linked to http://localhost:3000/login instead of the live site,
 * because the script read APP_URL from .env.local, which had it set to
 * localhost. This sends a short correction with the working link to
 * exactly the same recipient list — never a target discovered fresh via
 * listUsers, so it can never accidentally reach someone who didn't get
 * the original broken email.
 *
 * Read-only by default (prints the recipient list, sends nothing) — pass
 * --send to actually call Resend. assertProductionWriteConfirmed still
 * requires --production on top of --send for a non-local Supabase target.
 *
 * Usage:
 *   pnpm tsx scripts/send-link-correction-email.ts
 *   pnpm tsx scripts/send-link-correction-email.ts --send --production
 */
import { assertProductionWriteConfirmed } from "./lib/production-guard";

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "brohda. <notifications@brohda.com>";
const SUBJECT = "Quick fix: the link in our last email";
const APP_URL = "https://brohda.com";

// Exactly the 15 real recipients of the original send (10 sent cleanly,
// 5 retried after a rate-limit failure — all 15 got the broken link).
const RECIPIENTS = [
  "octamartinez@gmail.com",
  "benjasaenz@gmail.com",
  "paulasaenz81@gmail.com",
  "marcocordero70@gmail.com",
  "liasnz11@gmail.com",
  "demo@pollpools.demo",
  "atames28@gmail.com",
  "tererivascr@gmail.com",
  "ssrroblescano@gmail.com",
  "msm1524@gmail.com",
  "pescoto29@gmail.com",
  "asaenz76@gmail.com",
  "lasigera@gmail.com",
  "antosdesk@gmail.com",
  "unkibbled@gmail.com",
];

function buildLinkCorrectionEmail(): { subject: string; html: string } {
  const logoUrl = `${APP_URL}/email/brohda-logo.png`;
  const loginUrl = `${APP_URL}/login`;

  const html = `
    <div style="background-color:#f5f5f5;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
        <tr>
          <td style="padding-bottom:20px;text-align:center;">
            <img src="${logoUrl}" width="129" height="32" alt="brohda." style="display:inline-block;" />
          </td>
        </tr>
        <tr>
          <td style="background-color:#ffffff;border:1px solid #e8e8e8;border-radius:16px;padding:32px 28px;">
            <h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;font-weight:700;color:#111111;">Quick fix on our last email</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">Hi there,</p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">
              The "Add funds" button in our last email pointed to a broken link — sorry about that.
              Here's the correct one:
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
              <tr>
                <td align="center">
                  <a href="${loginUrl}" style="display:inline-block;background-color:#4f46e5;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:12px 28px;border-radius:10px;">Add funds</a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-size:15px;line-height:1.6;color:#444444;">
              Thanks again for being part of brohda's beta.
            </p>
            <p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#444444;">Warmly,<br />The brohda team</p>
          </td>
        </tr>
        <tr>
          <td style="padding-top:20px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#a3a3a3;">brohda. &middot; Questions? Just reply to this email.</p>
          </td>
        </tr>
      </table>
    </div>
  `.trim();

  return { subject: SUBJECT, html };
}

async function sendEmailDirect(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`  [no RESEND_API_KEY set — skipping actual send] ${to}`);
    return false;
  }
  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_ADDRESS, to, subject, html }),
    });
    if (!response.ok) {
      console.error(`  FAILED ${to}: ${response.status} ${await response.text()}`);
      return false;
    }
    console.log(`  sent -> ${to}`);
    return true;
  } catch (error) {
    console.error(`  FAILED ${to}:`, error);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendInBatches(emails: string[], subject: string, html: string, batchSize = 5): Promise<number> {
  let sentCount = 0;
  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((to) => sendEmailDirect(to, subject, html)));
    sentCount += results.filter(Boolean).length;
    if (i + batchSize < emails.length) await sleep(1100);
  }
  return sentCount;
}

async function main() {
  const send = process.argv.includes("--send");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const { subject, html } = buildLinkCorrectionEmail();

  console.log(`Subject: ${subject}`);
  console.log(`Recipients (${RECIPIENTS.length}): ${RECIPIENTS.join(", ")}`);

  if (!send) {
    console.log("\nDry run only — nothing was sent. Re-run with --send (and --production for a non-local target) to actually send.");
    return;
  }

  assertProductionWriteConfirmed(supabaseUrl, "send-link-correction-email");

  console.log(`\nSending to ${RECIPIENTS.length} recipients...`);
  const sentCount = await sendInBatches(RECIPIENTS, subject, html);
  console.log(`\nDone. ${sentCount}/${RECIPIENTS.length} sent successfully.`);
}

main();
