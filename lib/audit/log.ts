import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type WriteAuditLogInput = {
  actorId: string | null;
  /** A non-member actor (a Sponsor login) — they have no member profile, so they are attributed here instead of in actorId. */
  actorAccountId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
};

export async function writeAuditLog(input: WriteAuditLogInput) {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_account_id: input.actorAccountId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
    ip: input.ip ?? null,
  });

  if (error) {
    throw new Error(`Failed to write audit log: ${error.message}`);
  }
}
