/**
 * One-time announcement to every registered user: beta testing has ended,
 * the play money credited for testing will be removed, and the account
 * itself stays active with real-money deposits welcome going forward.
 *
 * Read-only by default (lists recipients, prints a preview, sends nothing)
 * — pass --send to actually call Resend. assertProductionWriteConfirmed
 * (see lib/production-guard.ts) still requires --production on top of
 * --send whenever the resolved Supabase URL isn't local, so a bare
 * `pnpm send-beta-sunset-email --send` against this project's .env.local
 * (which points at production) refuses to run.
 *
 * Usage:
 *   pnpm send-beta-sunset-email                        # dry run
 *   pnpm send-beta-sunset-email --send --production     # actually sends
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

// Not importing lib/email/resend.ts or lib/supabase/admin.ts: both are
// guarded by the "server-only" package, which throws unconditionally
// outside Next's react-server bundler condition — this script runs under
// plain tsx, so the admin client and the send call are inlined instead
// (same reasoning as create-super-admin.ts).
function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM_ADDRESS = "brohda. <notifications@brohda.com>";
const SUBJECT = "Thank you for beta testing brohda — an update on your account";
const REMOVAL_DATE = "September 1, 2026";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Mirrors buildPoolPublishedEmail's structure/tokens in lib/email/resend.ts
// (logo image, white card, #4f46e5 accent) so this reads as the same
// brohda. email, not a one-off design. The "Add funds" button matches the
// site's own Button component (rounded-lg = 10px radius, primary/
// primary-foreground colors — see app/globals.css) rather than the pill
// shape used elsewhere in email, per explicit branding feedback on the
// draft, and links to /login since a signed-out recipient has to
// authenticate before reaching /wallet.
function buildBetaSunsetEmail(appUrl: string): { subject: string; html: string } {
  const logoUrl = `${appUrl}/email/brohda-logo.png`;
  const loginUrl = `${appUrl}/login`;

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
            <h1 style="margin:0 0 16px;font-size:19px;line-height:1.35;font-weight:700;color:#111111;">Thank you for helping us build brohda</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">Hi there,</p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">
              We want to start with a genuine thank you. The time you spent testing brohda, the pools
              you entered, and the feedback you sent our way have shaped this app more than you know.
              Beta testers like you are the reason brohda is ready for what comes next, and we're
              really grateful for it.
            </p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">
              We're writing to let you know that our beta testing period has now come to a close.
            </p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">
              As part of wrapping up this phase, the play money credited to your account for testing
              will be removed from your balance on <strong>${escapeHtml(REMOVAL_DATE)}</strong>. This
              only resets that test balance — nothing else about your account changes.
            </p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">
              Your account itself will stay fully active. If you'd like to keep playing on brohda,
              you're welcome to add real funds to your wallet at any time and pick up right where you
              left off.
            </p>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444444;">
              Thank you again for your time, your trust, and everything you helped us learn along the
              way.
            </p>
            <p style="margin:0;font-size:15px;line-height:1.6;color:#444444;">Warmly,<br />The brohda team</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
              <tr>
                <td align="center">
                  <a href="${loginUrl}" style="display:inline-block;background-color:#4f46e5;color:#ffffff;font-size:14px;font-weight:500;text-decoration:none;padding:12px 28px;border-radius:10px;">Add funds</a>
                </td>
              </tr>
            </table>
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

// One confirmed typo in a real account's stored email (extra "o" in the
// TLD) — corrected only for where this one-time send actually goes, not
// written back to the account record itself.
const EMAIL_SEND_OVERRIDES: Record<string, string> = {
  "marcocordero70@gmail.coom": "marcocordero70@gmail.com",
};

// auth.admin.listUsers only returns one page at a time (max 1000/page) —
// every registered user means walking pages until one comes back empty,
// not just reading page 1 the way notifyFollowedPoolPublished does for its
// much smaller, pre-filtered recipient list. @example.com is the reserved
// test-only domain (RFC 2606) — this production project accumulated a
// dozen automated RLS-test accounts on it, none of which are real beta
// testers or even deliverable, so they're excluded before anything else
// sees the list, not filtered ad hoc at the call site.
async function listAllUserEmails(
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ emails: string[]; excludedCount: number }> {
  const emails: string[] = [];
  let excludedCount = 0;
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data.users;
    if (users.length === 0) break;
    for (const u of users) {
      if (!u.email) continue;
      if (u.email.toLowerCase().endsWith("@example.com")) {
        excludedCount += 1;
        continue;
      }
      emails.push(EMAIL_SEND_OVERRIDES[u.email.toLowerCase()] ?? u.email);
    }
    page += 1;
  }
  return { emails, excludedCount };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chunked concurrency with a pause between batches — Resend's limit is 10
// requests/second, and two batches of 5 fired back-to-back with no gap
// still landed inside the same window in practice (5/15 failed with 429 on
// the first real send). A 1.1s gap keeps every batch in its own window.
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

// --only=a@x.com,b@y.com targets a specific subset instead of the full
// listUsers sweep — for retrying the handful that hit Resend's rate limit
// on a prior run without re-sending (and duplicating) everyone who already
// got it successfully.
function parseOnlyFlag(): string[] | null {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  return arg
    .slice("--only=".length)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

async function main() {
  const send = process.argv.includes("--send");
  // Hardcoded, not read from process.env.APP_URL: this repo's .env.local
  // (the file scripts/send-beta-sunset-email.ts is invoked with, per its
  // "send-beta-sunset-email" npm script entry) has APP_URL set to
  // http://localhost:3000 even though it's meant to hold production
  // config — the deployed app itself gets the correct value straight from
  // Vercel's own project env vars, but a local script reading process.env
  // has no access to those. The first real send went out with a broken
  // localhost link in the "Add funds" button because of exactly this; a
  // one-time production-announcement script has no legitimate reason to
  // ever link anywhere but the real site, so this is pinned rather than
  // left to inherit whatever APP_URL happens to resolve to locally.
  const appUrl = "https://brohda.com";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const only = parseOnlyFlag();

  const { subject, html } = buildBetaSunsetEmail(appUrl);

  let emails: string[];
  let excludedCount = 0;
  if (only) {
    emails = only;
  } else {
    const admin = createAdminClient();
    ({ emails, excludedCount } = await listAllUserEmails(admin));
  }

  console.log(`Target Supabase: ${supabaseUrl}`);
  console.log(`Subject: ${subject}`);
  console.log(
    only
      ? `Recipients: ${emails.length} (--only override)`
      : `Recipients: ${emails.length} (excluded ${excludedCount} @example.com test account${excludedCount === 1 ? "" : "s"})`,
  );
  console.log(`Sample: ${emails.slice(0, 5).join(", ")}${emails.length > 5 ? ", ..." : ""}`);

  if (!send) {
    console.log("\nDry run only — nothing was sent. Re-run with --send (and --production for a non-local target) to actually send.");
    return;
  }

  assertProductionWriteConfirmed(supabaseUrl, "send-beta-sunset-email");

  console.log(`\nSending to ${emails.length} recipients...`);
  const sentCount = await sendInBatches(emails, subject, html);
  console.log(`\nDone. ${sentCount}/${emails.length} sent successfully.`);
}

main();
