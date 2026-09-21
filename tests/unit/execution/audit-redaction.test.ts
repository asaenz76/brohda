import { describe, expect, it, vi } from "vitest";

// Milestone 5.5 (STEP 18) — the audit module's redaction guard is the only
// thing standing between arbitrary caller metadata and durable storage.
// This proves it strips anything secret-shaped, recursively, regardless of
// caller intent, and never touches ordinary fields.

const insertMock = vi.fn().mockResolvedValue({ error: null });
const fromMock = vi.fn().mockReturnValue({ insert: insertMock });

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import { recordAuditEvent } from "@/lib/execution/audit";

function lastInsertPayload(): Record<string, unknown> {
  return insertMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("recordAuditEvent redaction", () => {
  it("redacts a top-level secret-shaped key", async () => {
    await recordAuditEvent({ eventType: "QUOTE_REQUESTED", metadata: { sessionKey: "super-secret-value", ok: true } });
    const payload = lastInsertPayload();
    expect((payload.metadata as Record<string, unknown>).sessionKey).toBe("[redacted]");
    expect((payload.metadata as Record<string, unknown>).ok).toBe(true);
  });

  it("redacts secret-shaped keys nested inside objects and arrays", async () => {
    await recordAuditEvent({
      eventType: "QUOTE_REQUESTED",
      metadata: { violations: [{ limitId: "abc", apiCredential: "leak-me" }], nested: { deeper: { privateKey: "also-leak-me" } } },
    });
    const payload = lastInsertPayload();
    const metadata = payload.metadata as { violations: Array<Record<string, unknown>>; nested: { deeper: Record<string, unknown> } };
    expect(metadata.violations[0].apiCredential).toBe("[redacted]");
    expect(metadata.violations[0].limitId).toBe("abc");
    expect(metadata.nested.deeper.privateKey).toBe("[redacted]");
  });

  it("catches every secret-shaped keyword this module guards against", async () => {
    await recordAuditEvent({
      eventType: "QUOTE_REQUESTED",
      metadata: { key: "x", secret: "x", credential: "x", signature: "x", token: "x", password: "x", privateThing: "x", safeField: "x" },
    });
    const metadata = lastInsertPayload().metadata as Record<string, unknown>;
    expect(metadata.key).toBe("[redacted]");
    expect(metadata.secret).toBe("[redacted]");
    expect(metadata.credential).toBe("[redacted]");
    expect(metadata.signature).toBe("[redacted]");
    expect(metadata.token).toBe("[redacted]");
    expect(metadata.password).toBe("[redacted]");
    expect(metadata.privateThing).toBe("[redacted]");
    expect(metadata.safeField).toBe("x");
  });

  it("defaults severity to INFO and passes through explicit fields", async () => {
    await recordAuditEvent({ eventType: "KILL_SWITCH_ACTIVATED", severity: "CRITICAL", correlationId: "c1", actorUserId: "u1" });
    const payload = lastInsertPayload();
    expect(payload.severity).toBe("CRITICAL");
    expect(payload.correlation_id).toBe("c1");
    expect(payload.actor_user_id).toBe("u1");

    await recordAuditEvent({ eventType: "QUOTE_REQUESTED" });
    const secondPayload = lastInsertPayload();
    expect(secondPayload.severity).toBe("INFO");
  });

  it("never throws when the insert itself fails — an audit outage must not break the execution flow it observes", async () => {
    insertMock.mockResolvedValueOnce({ error: { message: "db down" } });
    await expect(recordAuditEvent({ eventType: "QUOTE_REQUESTED" })).resolves.toBeUndefined();
  });
});
