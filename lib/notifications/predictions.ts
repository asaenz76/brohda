import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getPredictionNotificationCopyPolicy,
  getPredictionNotificationPolicy,
  shouldNotifyForResult,
} from "@/lib/predictions/policy";
import type { PredictionNotificationCopyPolicy, PredictionResult } from "@/lib/predictions/types";

/**
 * Milestone 3 notification (roadmap STEP 23). Deliberately only "your
 * Prediction was graded" — not "Prediction accepted", since the create
 * action already returns a synchronous on-screen confirmation
 * ("You predicted YES at 31%") and a redundant notification for something
 * the user is already looking at would be exactly the spam this codebase's
 * own notification precedent avoids (lib/notifications/create.ts's "no
 * dedup/throttle... one notification per real event", matched here by
 * calling this exactly once per newly-graded Prediction — see
 * lib/predictions/grading.ts).
 *
 * No `pool_id` — this is not a legacy pool event; `notifications.pool_id`
 * stays null, matching that column's existing nullable, optional
 * convention (it names a legacy business entity, not every notification).
 *
 * Milestone 3 final notification-policy remediation — correcting the
 * prior remediation's own classification: "no other notification type in
 * this codebase is configurable either" is existing precedent, not proof
 * of invariance, and whether/which grading results notify is genuinely
 * mutable product policy. `maybeCreatePredictionGradedNotification` below
 * is now the real entry point (called by lib/predictions/grading.ts) —
 * this lower-level function is kept as the actual insert, used only after
 * policy has already said yes.
 *
 * **Copy** (title/body wording) is now ALSO configurable (final copy
 * remediation), correcting that same prior classification a second time —
 * `renderNotificationCopy` below reads `platform_settings`
 * (migration 20260101000147) through `getPredictionNotificationCopyPolicy`
 * and falls back to `DEFAULT_NOTIFICATION_COPY` only when that policy is
 * unreadable/malformed. `{{question}}` is a plain literal placeholder,
 * substituted by string replacement — never evaluated as code, never a
 * templating/expression language.
 */
export async function createPredictionGradedNotification(input: {
  userId: string;
  predictionId: string;
  questionSnapshot: string;
  result: PredictionResult;
  /** Stage 4A remediation (Stage 4 audit §14) — the canonical Post this grading was about, for click-through (lib/notifications/links.ts). Null when the grading job's own fixture->Post lookup came up empty (data anomaly) — the notification is still created, just not clickable. */
  postId: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const copyPolicy = await getPredictionNotificationCopyPolicy();
  const { title, body } = renderNotificationCopy(input.result, input.questionSnapshot, copyPolicy);

  const { error } = await admin.from("notifications").insert({
    user_id: input.userId,
    type: "prediction_graded",
    title,
    body,
    pool_id: null,
    post_id: input.postId,
  });
  if (error) throw error;
}

/**
 * The policy-aware entry point grading actually calls. Consults
 * `getPredictionNotificationPolicy()` (fail-closed — see that function's
 * own comment) and only creates the notification when
 * `shouldNotifyForResult` says yes. Never throws: a policy read failure or
 * a notification-insert failure is logged and swallowed here, not
 * propagated — grading has already persisted the Prediction's result and
 * updated the factual aggregates by the time this is called (see
 * lib/predictions/grading.ts), and an optional, best-effort notification
 * must never be able to make that already-successful grading outcome look
 * like a failure to its caller. A copy-policy read failure is likewise
 * never able to block the notification or affect grading — see
 * `renderNotificationCopy`'s own fallback.
 */
export async function maybeCreatePredictionGradedNotification(input: {
  userId: string;
  predictionId: string;
  questionSnapshot: string;
  result: PredictionResult;
  postId: string | null;
}): Promise<void> {
  const policy = await getPredictionNotificationPolicy();
  if (!shouldNotifyForResult(input.result, policy)) return;

  try {
    await createPredictionGradedNotification(input);
  } catch (error) {
    console.error(
      `[predictions] prediction_graded notification failed for prediction ${input.predictionId} — grading result is unaffected:`,
      error,
    );
  }
}

/**
 * Built-in fallback wording — used only when `getPredictionNotificationCopyPolicy()`
 * returns `null` (missing row, malformed data, or a read error). Identical
 * to this notification's original hard-coded strings, so a copy-policy
 * failure degrades to exactly the previous, known-good behavior rather
 * than a broken or missing message.
 */
export const DEFAULT_NOTIFICATION_COPY: PredictionNotificationCopyPolicy = {
  correct: { title: "You were right", body: 'Your prediction on "{{question}}" was correct.' },
  incorrect: { title: "Result is in", body: 'Your prediction on "{{question}}" was incorrect.' },
  void: { title: "No result this time", body: '"{{question}}" didn\'t reach a final result, so this prediction won\'t count.' },
};

/**
 * The pure copy-rendering decision — no I/O, unit-testable with an
 * explicit policy value. Selects the template for `result` from `policy`
 * when present, else from `DEFAULT_NOTIFICATION_COPY`, then substitutes
 * every `{{question}}` occurrence with the real question text via a plain
 * string replace (`String.prototype.replaceAll` — literal substitution,
 * not `eval`/a template-expression engine, so the stored template can
 * never do anything but appear verbatim with one substitution applied).
 */
export function renderNotificationCopy(
  result: PredictionResult,
  question: string,
  policy: PredictionNotificationCopyPolicy | null,
): { title: string; body: string } {
  const source = policy ?? DEFAULT_NOTIFICATION_COPY;
  const template = result === "CORRECT" ? source.correct : result === "INCORRECT" ? source.incorrect : source.void;
  return {
    title: template.title.replaceAll("{{question}}", question),
    body: template.body.replaceAll("{{question}}", question),
  };
}
