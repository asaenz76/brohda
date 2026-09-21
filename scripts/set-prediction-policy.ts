/**
 * The protected operational path for changing Milestone 3's prediction
 * eligibility policy (docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 3).
 * Policy lives in `platform_settings` (migration 20260101000142); this
 * script is how an operator edits it without a code change or deployment —
 * same reasoning and shape as scripts/set-capability-policy.ts, for a
 * different reason: not a privilege-escalation surface here, but simply
 * that this codebase's existing admin settings page (app/(admin)/admin/
 * settings/page.tsx) is a hand-built form, and adding five new toggle
 * fields there is exactly the kind of UI surface not yet worth building
 * for a milestone this narrow (see docs/architecture/prediction-layer.md).
 * A future milestone may promote this to the settings page if these knobs
 * turn out to need frequent operator attention.
 *
 * Usage:
 *   pnpm set-prediction-policy --show
 *   pnpm set-prediction-policy --allow-repeat=true
 *   pnpm set-prediction-policy --cutoff-minutes=15
 *   pnpm set-prediction-policy --allow-stale=true --allow-unavailable=false --allow-closed=false
 *   pnpm set-prediction-policy --notifications-enabled=false
 *   pnpm set-prediction-policy --notify-on-correct=true --notify-on-incorrect=true --notify-on-void=false
 *   pnpm set-prediction-policy --title-correct="Nice call" --body-correct='Your prediction on "{{question}}" hit.'
 *
 * The notification-policy and copy-template flags (migrations
 * 20260101000146/20260101000147) were added in later remediations,
 * extending this same script rather than adding a new one — same table,
 * same operator path, same reasoning as the original five eligibility
 * knobs. `{{question}}` in a `--title-*`/`--body-*` value is a plain
 * literal placeholder substituted at send time
 * (lib/notifications/predictions.ts) — not evaluated as code.
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

// Same reason as create-super-admin.ts/set-capability-policy.ts:
// lib/supabase/admin.ts is guarded by the `server-only` package, which
// throws outside Next's react-server condition — which is exactly this
// plain-tsx context.
function createAdminClient() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getBoolArg(flag: string): boolean | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return undefined;
  const value = arg.split("=")[1];
  if (value === "true") return true;
  if (value === "false") return false;
  console.error(`${flag} must be =true or =false`);
  process.exit(1);
}

function getIntArg(flag: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return undefined;
  const value = Number.parseInt(arg.split("=")[1], 10);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${flag} must be a non-negative integer`);
    process.exit(1);
  }
  return value;
}

// Unlike getBoolArg/getIntArg, slices after the FIRST "=" only — title/body
// text may itself legitimately contain "=" (or nothing at all), so
// splitting on every "=" would corrupt the value.
function getStringArg(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (arg === undefined) return undefined;
  const value = arg.slice(flag.length + 1);
  if (value.length === 0) {
    console.error(`${flag} must not be empty`);
    process.exit(1);
  }
  return value;
}

const COLUMNS =
  "prediction_allow_repeat, prediction_cutoff_minutes_before_close, prediction_allow_stale_price, prediction_allow_unavailable_price, prediction_allow_closed_market, prediction_notifications_enabled, prediction_notify_on_correct, prediction_notify_on_incorrect, prediction_notify_on_void, prediction_notify_title_correct, prediction_notify_body_correct, prediction_notify_title_incorrect, prediction_notify_body_incorrect, prediction_notify_title_void, prediction_notify_body_void";

async function main() {
  const admin = createAdminClient();

  if (process.argv.includes("--show")) {
    const { data, error } = await admin.from("platform_settings").select(COLUMNS).eq("id", true).single();
    if (error) {
      console.error("Failed to read prediction policy:", error.message);
      process.exit(1);
    }
    console.log(data);
    return;
  }

  const update: Record<string, boolean | number | string> = {};
  const allowRepeat = getBoolArg("--allow-repeat");
  if (allowRepeat !== undefined) update.prediction_allow_repeat = allowRepeat;
  const cutoffMinutes = getIntArg("--cutoff-minutes");
  if (cutoffMinutes !== undefined) update.prediction_cutoff_minutes_before_close = cutoffMinutes;
  const allowStale = getBoolArg("--allow-stale");
  if (allowStale !== undefined) update.prediction_allow_stale_price = allowStale;
  const allowUnavailable = getBoolArg("--allow-unavailable");
  if (allowUnavailable !== undefined) update.prediction_allow_unavailable_price = allowUnavailable;
  const allowClosed = getBoolArg("--allow-closed");
  if (allowClosed !== undefined) update.prediction_allow_closed_market = allowClosed;
  const notificationsEnabled = getBoolArg("--notifications-enabled");
  if (notificationsEnabled !== undefined) update.prediction_notifications_enabled = notificationsEnabled;
  const notifyOnCorrect = getBoolArg("--notify-on-correct");
  if (notifyOnCorrect !== undefined) update.prediction_notify_on_correct = notifyOnCorrect;
  const notifyOnIncorrect = getBoolArg("--notify-on-incorrect");
  if (notifyOnIncorrect !== undefined) update.prediction_notify_on_incorrect = notifyOnIncorrect;
  const notifyOnVoid = getBoolArg("--notify-on-void");
  if (notifyOnVoid !== undefined) update.prediction_notify_on_void = notifyOnVoid;
  const titleCorrect = getStringArg("--title-correct");
  if (titleCorrect !== undefined) update.prediction_notify_title_correct = titleCorrect;
  const bodyCorrect = getStringArg("--body-correct");
  if (bodyCorrect !== undefined) update.prediction_notify_body_correct = bodyCorrect;
  const titleIncorrect = getStringArg("--title-incorrect");
  if (titleIncorrect !== undefined) update.prediction_notify_title_incorrect = titleIncorrect;
  const bodyIncorrect = getStringArg("--body-incorrect");
  if (bodyIncorrect !== undefined) update.prediction_notify_body_incorrect = bodyIncorrect;
  const titleVoid = getStringArg("--title-void");
  if (titleVoid !== undefined) update.prediction_notify_title_void = titleVoid;
  const bodyVoid = getStringArg("--body-void");
  if (bodyVoid !== undefined) update.prediction_notify_body_void = bodyVoid;

  if (Object.keys(update).length === 0) {
    console.error(
      "Usage:\n  pnpm set-prediction-policy --show\n  pnpm set-prediction-policy --allow-repeat=true|false --cutoff-minutes=N --allow-stale=true|false --allow-unavailable=true|false --allow-closed=true|false\n  pnpm set-prediction-policy --notifications-enabled=true|false --notify-on-correct=true|false --notify-on-incorrect=true|false --notify-on-void=true|false\n  pnpm set-prediction-policy --title-correct=... --body-correct=... --title-incorrect=... --body-incorrect=... --title-void=... --body-void=...\n(pass only the flags you want to change)",
    );
    process.exit(1);
  }

  assertProductionWriteConfirmed(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "set-prediction-policy");

  const { error } = await admin.from("platform_settings").update(update).eq("id", true);
  if (error) {
    console.error("Failed to write prediction policy:", error.message);
    process.exit(1);
  }

  console.log("Updated:", update);
}

main();
