/**
 * One-time bootstrap for the first Super Admin account (spec §6.1: "One
 * admin account for MVP"). Invite-only registration has no path for the
 * very first user, since there's no admin yet to send an invitation.
 *
 * Usage:
 *   pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin Name"
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Not importing lib/supabase/admin.ts here: it's guarded by the `server-only`
// package, which throws unconditionally when required outside Next's
// `react-server` bundler condition — which is exactly the plain-Node
// context this script runs in via tsx. Build the same client inline instead.
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

async function main() {
  const email = getArg("--email");
  const password = getArg("--password");
  const displayName = getArg("--name") ?? "Super Admin";

  if (!email || !password) {
    console.error(
      "Usage: pnpm create-super-admin --email you@example.com --password 'xxxx' --name \"Admin Name\"",
    );
    process.exit(1);
  }

  const admin = createAdminClient();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    console.error("Failed to create auth user:", createError?.message);
    process.exit(1);
  }

  const { error: profileError } = await admin.from("user_profiles").insert({
    id: created.user.id,
    display_name: displayName,
    role: "super_admin",
    is_active: true,
  });

  if (profileError) {
    console.error("Failed to create profile row:", profileError.message);
    process.exit(1);
  }

  console.log(`Super admin created: ${email} (${created.user.id})`);
}

main();
