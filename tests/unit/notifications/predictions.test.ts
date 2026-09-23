import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_COPY, renderNotificationCopy } from "@/lib/notifications/predictions";
import type { PredictionNotificationCopyPolicy } from "@/lib/predictions/types";

/**
 * The pure `prediction_graded` copy-rendering decision, in isolation from
 * any database (final copy-configuration remediation). Everything here is
 * about two properties: an unreadable/malformed copy policy falls back to
 * known-good built-in wording (never a blank/broken notification), and
 * `{{question}}` is substituted as a plain literal, never evaluated.
 */

const CUSTOM_POLICY: PredictionNotificationCopyPolicy = {
  correct: { title: "Nice call", body: 'You nailed "{{question}}".' },
  incorrect: { title: "Not this time", body: '"{{question}}" didn\'t go your way.' },
  void: { title: "No result", body: '"{{question}}" never settled.' },
};

describe("renderNotificationCopy", () => {
  it("uses the default built-in wording when policy is null, substituting the question", () => {
    expect(renderNotificationCopy("CORRECT", "Will it rain?", null)).toEqual({
      title: "You were right",
      body: 'Your prediction on "Will it rain?" was correct.',
    });
    expect(renderNotificationCopy("INCORRECT", "Will it rain?", null)).toEqual({
      title: "Result is in",
      body: 'Your prediction on "Will it rain?" was incorrect.',
    });
    expect(renderNotificationCopy("VOID", "Will it rain?", null)).toEqual({
      title: "No result this time",
      body: '"Will it rain?" didn\'t reach a final result, so this prediction won\'t count.',
    });
  });

  it("uses the configured wording when a policy is provided — proving copy is genuinely configurable", () => {
    expect(renderNotificationCopy("CORRECT", "Will it rain?", CUSTOM_POLICY)).toEqual({
      title: "Nice call",
      body: 'You nailed "Will it rain?".',
    });
    expect(renderNotificationCopy("INCORRECT", "Will it rain?", CUSTOM_POLICY)).toEqual({
      title: "Not this time",
      body: '"Will it rain?" didn\'t go your way.',
    });
    expect(renderNotificationCopy("VOID", "Will it rain?", CUSTOM_POLICY)).toEqual({
      title: "No result",
      body: '"Will it rain?" never settled.',
    });
  });

  it("substitutes every {{question}} occurrence, never derives it any other way", () => {
    const policy: PredictionNotificationCopyPolicy = {
      ...CUSTOM_POLICY,
      correct: { title: "{{question}}: correct!", body: "{{question}} — {{question}}" },
    };
    expect(renderNotificationCopy("CORRECT", "X", policy)).toEqual({
      title: "X: correct!",
      body: "X — X",
    });
  });

  it("treats the placeholder as a literal string, never as code to evaluate", () => {
    const policy: PredictionNotificationCopyPolicy = {
      ...CUSTOM_POLICY,
      correct: { title: "safe", body: "{{question}}" },
    };
    const maliciousQuestion = "${process.env.SECRET} <script>alert(1)</script>";
    expect(renderNotificationCopy("CORRECT", maliciousQuestion, policy).body).toBe(maliciousQuestion);
  });

  it("DEFAULT_NOTIFICATION_COPY matches this notification's original hard-coded wording exactly", () => {
    expect(DEFAULT_NOTIFICATION_COPY).toEqual({
      correct: { title: "You were right", body: 'Your prediction on "{{question}}" was correct.' },
      incorrect: { title: "Result is in", body: 'Your prediction on "{{question}}" was incorrect.' },
      void: { title: "No result this time", body: '"{{question}}" didn\'t reach a final result, so this prediction won\'t count.' },
    });
  });
});
