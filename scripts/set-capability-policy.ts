/**
 * The protected operational path for changing a capability's allowed roles
 * (Milestone 2 final standing-rule remediation). Authorization policy is
 * data (`capability_policies`, migration 20260101000140); this script is how
 * an operator edits that data without a code change or a deployment.
 *
 * Usage:
 *   pnpm set-capability-policy --show
 *   pnpm set-capability-policy --capability discovery_taxonomy_management --roles super_admin,admin
 *   pnpm set-capability-policy --capability discovery_taxonomy_management --roles super_admin
 *
 * Deliberately a script and not an admin screen: who may manage taxonomy is
 * a privilege decision, and this codebase already keeps privilege decisions
 * (role assignment, the first super admin) off the admin panel and behind
 * the service-role key — see scripts/create-super-admin.ts. A UI that let an
 * admin widen their own authorization would be a privilege-escalation
 * surface, not a convenience.
 *
 * Validates capability and role names against the running application's own
 * sets before writing, so an operator typo fails loudly here instead of
 * becoming a policy the application must refuse at request time.
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { assertProductionWriteConfirmed } from "./lib/production-guard";
import { APP_CAPABILITIES, APP_ROLES } from "../lib/auth/capability-policy";

// Same reason as create-super-admin.ts: lib/supabase/admin.ts is guarded by
// the `server-only` package, which throws outside Next's react-server
// condition — which is exactly this plain-tsx context.
function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const USAGE =
  "Usage:\n" +
  "  pnpm set-capability-policy --show\n" +
  "  pnpm set-capability-policy --capability <capability> --roles <role[,role...]>\n\n" +
  `Capabilities: ${APP_CAPABILITIES.join(", ")}\n` +
  `Roles:        ${APP_ROLES.join(", ")}\n` +
  "Pass --roles '' to permit nobody.";

async function main() {
  const admin = createAdminClient();

  if (process.argv.includes("--show")) {
    const { data, error } = await admin.from("capability_policies").select("capability, allowed_roles, updated_at");
    if (error) {
      console.error("Failed to read capability policies:", error.message);
      process.exit(1);
    }
    for (const row of data ?? []) {
      console.log(`${row.capability}: ${(row.allowed_roles as string[]).join(", ") || "(nobody)"}  [updated ${row.updated_at}]`);
    }
    return;
  }

  const capability = getArg("--capability");
  const rolesArg = getArg("--roles");

  if (!capability || rolesArg === undefined) {
    console.error(USAGE);
    process.exit(1);
  }

  if (!(APP_CAPABILITIES as readonly string[]).includes(capability)) {
    console.error(`Unknown capability "${capability}".\n\n${USAGE}`);
    process.exit(1);
  }

  const roles = rolesArg
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
  const unknown = roles.filter((role) => !(APP_ROLES as readonly string[]).includes(role));
  if (unknown.length > 0) {
    console.error(`Unknown role(s): ${unknown.join(", ")}.\n\n${USAGE}`);
    process.exit(1);
  }

  assertProductionWriteConfirmed(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "set-capability-policy");

  const { data: before } = await admin
    .from("capability_policies")
    .select("allowed_roles")
    .eq("capability", capability)
    .maybeSingle();

  const { error } = await admin
    .from("capability_policies")
    .upsert({ capability, allowed_roles: roles }, { onConflict: "capability" });
  if (error) {
    console.error("Failed to write capability policy:", error.message);
    process.exit(1);
  }

  // Same audit expectation as every other privileged change in this
  // codebase. No actor id: this path is authenticated by possession of the
  // service-role key, not by a signed-in user.
  const { error: auditError } = await admin.from("audit_logs").insert({
    actor_id: null,
    action: "capability_policy.updated",
    entity_type: "capability_policy",
    entity_id: capability,
    before: before ? { allowedRoles: before.allowed_roles } : null,
    after: { allowedRoles: roles },
    reason: "set-capability-policy script",
  });
  if (auditError) {
    console.error("Policy written, but the audit log entry failed:", auditError.message);
    process.exit(1);
  }

  console.log(`${capability}: ${roles.join(", ") || "(nobody)"}`);
}

main();
