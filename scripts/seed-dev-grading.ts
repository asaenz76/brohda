/**
 * Deterministic local-dev seed for exercising the full pool lifecycle —
 * creation, entry, locking, automatic grading from a "final" fixture,
 * automatic settlement, and refund — without depending on live
 * API-Football imports. Complements scripts/seed.ts (which is demo data,
 * not idempotent, and not scoped to the grading pipeline specifically).
 *
 * Unlike scripts/seed.ts, this script:
 *   - refuses to run against anything but a local Supabase instance
 *   - is idempotent: every entity is looked up before being created, and
 *     reruns never duplicate rows or reset a pool's real progress. If
 *     you've since graded/settled a seeded pool by hand, rerunning this
 *     script will not undo that — it only fills in what's still missing.
 *   - uses a fixed, clearly-dev-only provider name ("dev_seed") and fixed
 *     external IDs/UUIDs so every entity is deterministic across runs.
 *
 * Run with (see README/docs/DEPLOYMENT.md for full local setup):
 *   pnpm supabase:start
 *   pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
 *   pnpm seed:dev-grading
 *
 * NEVER run against production — enforced below, not just documented.
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// Hard guard: this script moves wallet balances and creates auth users, so
// unlike scripts/seed.ts (which only documents "never run against
// production" in a comment) this one refuses outright. Local Supabase
// always serves from 127.0.0.1/localhost — anything else aborts.
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) {
  console.error(
    `Refusing to run: NEXT_PUBLIC_SUPABASE_URL ("${SUPABASE_URL}") is not a local Supabase instance.\n` +
      "This script is dev-only and moves wallet balances. Run it with .env.development.local, e.g.:\n" +
      "  npx dotenv -e .env.development.local -- tsx scripts/seed-dev-grading.ts",
  );
  process.exit(1);
}

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PROVIDER = "dev_seed";
const PASSWORD = "DevSeedGrading123!";

// Fixed, deterministic UUIDs — reruns upsert onto the same rows instead of
// minting new ones each time.
const IDS = {
  poolOpen: "00000000-0000-4000-a000-000000000001",
  poolLocked: "00000000-0000-4000-a000-000000000002",
  poolGradeable: "00000000-0000-4000-a000-000000000003",
  poolRefundable: "00000000-0000-4000-a000-000000000004",
} as const;

const USERS = [
  { email: "dev-seed-alice@brohda.dev", username: "devseedalice", displayName: "Dev Seed Alice" },
  { email: "dev-seed-bob@brohda.dev", username: "devseedbob", displayName: "Dev Seed Bob" },
  { email: "dev-seed-carol@brohda.dev", username: "devseedcarol", displayName: "Dev Seed Carol" },
] as const;

const STARTING_BALANCE_CENTS = 5000; // $50 — comfortably covers every pool's $10 entry fee below.
const ENTRY_FEE_CENTS = 1000; // $10
const HOUSE_FEE_BPS = 1000; // 10%

function log(step: string) {
  console.log(`  ${step}`);
}

async function getSuperAdminId(): Promise<string> {
  const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").limit(1).single();
  if (!data) {
    console.error("No super admin found — run `pnpm create-super-admin` first.");
    process.exit(1);
  }
  return data.id as string;
}

async function getOrCreateUser(email: string, username: string, displayName: string): Promise<string> {
  // supabase-js's admin.createUser doesn't accept a caller-supplied id, so
  // idempotency here means "look it up first," not "upsert by id." Looked
  // up via user_profiles.username (unique, and FKs to an auth user that
  // must therefore already exist) rather than admin.auth.admin.listUsers()
  // — listUsers() only returns its first paginated page (~50 users) with
  // no email filter, so on a database with 50+ other users (e.g. after the
  // integration test suite has run, which mints a fresh throwaway user per
  // test) the dev-seed users fall off that page and this lookup silently
  // misses, causing createUser to fail on rerun with "already registered."
  const { data: existingProfile } = await admin
    .from("user_profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  let userId: string;
  if (existingProfile) {
    userId = existingProfile.id as string;
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error(`failed to create user ${email}`);
    userId = data.user.id;
  }

  // upsert, not insert — safe to rerun, and self-heals if the profile row
  // was ever missing for an existing auth user.
  const { error: profileError } = await admin
    .from("user_profiles")
    .upsert({ id: userId, display_name: displayName, username, role: "player", is_active: true }, { onConflict: "id" });
  if (profileError) throw profileError;

  const { data: balanceRow } = await admin.from("wallet_balances").select("balance").eq("user_id", userId).single();
  if (!balanceRow || balanceRow.balance < STARTING_BALANCE_CENTS) {
    const { error: fundError } = await admin.rpc("apply_wallet_transaction", {
      p_account_type: "user",
      p_user_id: userId,
      p_type: "manual_deposit",
      p_direction: "credit",
      p_amount: STARTING_BALANCE_CENTS,
      p_admin_id: null,
      p_reason: "dev-seed funding",
      // Fixed key: a rerun against an already-funded wallet is a no-op via
      // apply_wallet_transaction's own idempotency-key guard, never a
      // double-credit.
      p_idempotency_key: `dev-seed:fund:${userId}`,
    });
    if (fundError) throw fundError;
  }

  return userId;
}

async function upsertLeagueAndImport(): Promise<{ leagueExternalId: string; season: string }> {
  const leagueExternalId = "dev-seed-league-1";
  const season = "2026";

  const { data: league, error: leagueError } = await admin
    .from("leagues")
    .upsert(
      { provider: PROVIDER, external_id: leagueExternalId, name: "Dev Seed League" },
      { onConflict: "provider,external_id" },
    )
    .select("id")
    .single();
  if (leagueError || !league) throw leagueError ?? new Error("failed to upsert dev-seed league");

  // The pool-creation eligibility view (fixtures_available_for_pool_creation)
  // hard-gates on a matching, IMPORTED, non-archived, pool_creation_enabled
  // league_season_imports row — this is that row. Without it the seeded
  // "open-eligible" fixture below would never appear in the creation
  // wizard, no matter how correct the fixture row itself is.
  const { error: importError } = await admin.from("league_season_imports").upsert(
    {
      provider: PROVIDER,
      external_league_id: leagueExternalId,
      season,
      league_id: league.id,
      import_status: "IMPORTED",
      pool_creation_enabled: true,
      archived_at: null,
    },
    { onConflict: "provider,external_league_id,season" },
  );
  if (importError) throw importError;

  return { leagueExternalId, season };
}

async function upsertTeams(): Promise<{ homeExternalId: string; awayExternalId: string }> {
  const homeExternalId = "dev-seed-team-home";
  const awayExternalId = "dev-seed-team-away";
  const { error } = await admin.from("teams").upsert(
    [
      { provider: PROVIDER, external_id: homeExternalId, name: "Dev Seed Home FC" },
      { provider: PROVIDER, external_id: awayExternalId, name: "Dev Seed Away FC" },
    ],
    { onConflict: "provider,external_id" },
  );
  if (error) throw error;
  return { homeExternalId, awayExternalId };
}

interface FixtureSpec {
  externalId: string;
  internalStatus: string;
  scheduledStartUtc: string;
  regulationHomeScore: number | null;
  regulationAwayScore: number | null;
}

async function upsertFixture(
  spec: FixtureSpec,
  competition: { leagueExternalId: string; season: string },
  teams: { homeExternalId: string; awayExternalId: string },
): Promise<{ id: string; internal_status: string; regulation_home_score: number | null; regulation_away_score: number | null }> {
  const { data, error } = await admin
    .from("fixtures")
    .upsert(
      {
        provider: PROVIDER,
        external_fixture_id: spec.externalId,
        competition_external_id: competition.leagueExternalId,
        competition_name: "Dev Seed League",
        season: competition.season,
        home_team_external_id: teams.homeExternalId,
        home_team_name: "Dev Seed Home FC",
        away_team_external_id: teams.awayExternalId,
        away_team_name: "Dev Seed Away FC",
        scheduled_start_utc: spec.scheduledStartUtc,
        internal_status: spec.internalStatus,
        regulation_home_score: spec.regulationHomeScore,
        regulation_away_score: spec.regulationAwayScore,
      },
      { onConflict: "provider,external_fixture_id" },
    )
    .select("id, internal_status, regulation_home_score, regulation_away_score")
    .single();
  if (error || !data) throw error ?? new Error(`failed to upsert fixture ${spec.externalId}`);
  return data;
}

/**
 * Creates a TEMPLATE_GRADED pool (HOME_TEAM_TO_WIN, binary Yes/No) with a
 * fixed id if it doesn't already exist. Returns whether this call actually
 * created it — callers use that to decide whether it's safe to advance the
 * pool's lifecycle (entries, locking) or whether a prior run (or a
 * developer's manual testing since) already has it further along and must
 * not be disturbed.
 */
async function getOrCreatePool(
  id: string,
  fixtureId: string,
  creatorId: string,
  question: string,
  locksAt: string,
): Promise<{ created: boolean; yesOptionId: string; noOptionId: string }> {
  const { data: existingPool } = await admin.from("pools").select("id").eq("id", id).maybeSingle();
  if (existingPool) {
    const { data: options } = await admin.from("pool_options").select("id, binary_outcome").eq("pool_id", id);
    const yesOptionId = options?.find((o) => o.binary_outcome === "YES")?.id as string;
    const noOptionId = options?.find((o) => o.binary_outcome === "NO")?.id as string;
    return { created: false, yesOptionId, noOptionId };
  }

  const { error: poolError } = await admin.from("pools").insert({
    id,
    fixture_id: fixtureId,
    created_by: creatorId,
    pool_type: "TEMPLATE_GRADED",
    template_id: "HOME_TEAM_TO_WIN",
    template_version: 1,
    template_config: {},
    participation_rule_version: 2,
    question,
    entry_fee: ENTRY_FEE_CENTS,
    house_fee_bps: HOUSE_FEE_BPS,
    min_total_entries: 2,
    open_at: new Date().toISOString(),
    locks_at: locksAt,
    status: "OPEN",
  });
  if (poolError) throw poolError;

  const { data: optionRows, error: optionsError } = await admin
    .from("pool_options")
    .insert([
      { pool_id: id, label: "Yes", sort_order: 0, binary_outcome: "YES" },
      { pool_id: id, label: "No", sort_order: 1, binary_outcome: "NO" },
    ])
    .select("id, binary_outcome");
  if (optionsError || !optionRows) throw optionsError ?? new Error("failed to create pool options");

  return {
    created: true,
    yesOptionId: optionRows.find((o) => o.binary_outcome === "YES")!.id as string,
    noOptionId: optionRows.find((o) => o.binary_outcome === "NO")!.id as string,
  };
}

function enterPool(poolId: string, userId: string, optionId: string) {
  // Fixed idempotency key — create_pool_entry returns the existing entry
  // on a rerun without re-checking pool status, so this stays safe to call
  // even after the pool has since moved past OPEN.
  return admin.rpc("create_pool_entry", {
    p_pool_id: poolId,
    p_user_id: userId,
    p_option_id: optionId,
    p_amount: ENTRY_FEE_CENTS,
    p_idempotency_key: `dev-seed:entry:${poolId}:${userId}`,
  });
}

async function main() {
  console.log("Seeding deterministic dev-grading data...");

  const adminId = await getSuperAdminId();
  log("Super admin resolved.");

  const competition = await upsertLeagueAndImport();
  log("League + league_season_imports (IMPORTED, pool_creation_enabled) upserted.");

  const teams = await upsertTeams();
  log("Teams upserted.");

  const [alice, bob, carol] = await Promise.all(USERS.map((u) => getOrCreateUser(u.email, u.username, u.displayName)));
  log(`Users ready: ${USERS.map((u) => u.email).join(", ")} (password: ${PASSWORD}).`);

  const now = Date.now();

  // F1 — scheduled, no pool attached: exists purely so the pool-creation
  // wizard's fixture search has a real eligible fixture to find (Part 2).
  const openEligibleFixture = await upsertFixture(
    {
      externalId: "dev-seed-fixture-open-eligible",
      internalStatus: "NOT_STARTED",
      scheduledStartUtc: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString(),
      regulationHomeScore: null,
      regulationAwayScore: null,
    },
    competition,
    teams,
  );

  // F2 — backs the OPEN pool, with locks_at already in the past so the
  // real lock-pools cron (or `checkPoolResultNowAction`-style manual call)
  // can be exercised against it immediately.
  const willLockFixture = await upsertFixture(
    {
      externalId: "dev-seed-fixture-will-lock",
      internalStatus: "NOT_STARTED",
      scheduledStartUtc: new Date(now + 60 * 60 * 1000).toISOString(),
      regulationHomeScore: null,
      regulationAwayScore: null,
    },
    competition,
    teams,
  );

  // F3 — backs a pool that's already LOCKED, match in progress.
  const lockedFixture = await upsertFixture(
    {
      externalId: "dev-seed-fixture-locked",
      internalStatus: "LIVE",
      scheduledStartUtc: new Date(now - 30 * 60 * 1000).toISOString(),
      regulationHomeScore: null,
      regulationAwayScore: null,
    },
    competition,
    teams,
  );

  // F4 — COMPLETED with a final score: the fixture the automatic-grading
  // pipeline should pick up and grade cleanly (home wins 2-1, so
  // HOME_TEAM_TO_WIN's YES option is correct).
  const gradeableFixture = await upsertFixture(
    {
      externalId: "dev-seed-fixture-completed",
      internalStatus: "COMPLETED",
      scheduledStartUtc: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
      regulationHomeScore: 2,
      regulationAwayScore: 1,
    },
    competition,
    teams,
  );

  // F5 — CANCELLED, scheduled safely in the past so the same-calendar-day
  // grace window has already closed: the automatic refund path
  // (processAwaitingResults' anomaly branch -> confirm_pool_refund) should
  // fire the moment it's exercised, with no manual admin step needed.
  const cancelledFixture = await upsertFixture(
    {
      externalId: "dev-seed-fixture-cancelled",
      internalStatus: "CANCELLED",
      scheduledStartUtc: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      regulationHomeScore: null,
      regulationAwayScore: null,
    },
    competition,
    teams,
  );
  log("5 fixtures upserted: open-eligible, will-lock, locked, completed(gradeable), cancelled(refundable).");

  // Pool 1 — OPEN, entries from 2 users on different outcomes. Left OPEN
  // (not force-advanced) since willLockFixture's locks_at has already
  // passed — the lock cron is what should move it, not this script.
  const p1 = await getOrCreatePool(IDS.poolOpen, willLockFixture.id, adminId, "Will Dev Seed Home FC win?", new Date(now + 60 * 60 * 1000).toISOString());
  if (p1.created) {
    await enterPool(IDS.poolOpen, alice, p1.yesOptionId);
    await enterPool(IDS.poolOpen, bob, p1.noOptionId);
    // Backdate locks_at now that entries are in, so it's immediately due
    // for the lock cron — entries themselves required locks_at to still be
    // in the future at insert time (create_pool_entry enforces this).
    await admin.from("pools").update({ locks_at: new Date(now - 60 * 1000).toISOString() }).eq("id", IDS.poolOpen);
  }
  log(`Pool 1 (OPEN, due to lock): ${p1.created ? "created" : "already existed — left untouched"}.`);

  // Pool 2 — snapshotted directly into LOCKED, mixed entries.
  const p2 = await getOrCreatePool(IDS.poolLocked, lockedFixture.id, adminId, "Will Dev Seed Home FC win?", new Date(now + 60 * 60 * 1000).toISOString());
  if (p2.created) {
    await enterPool(IDS.poolLocked, alice, p2.yesOptionId);
    await enterPool(IDS.poolLocked, bob, p2.noOptionId);
    await enterPool(IDS.poolLocked, carol, p2.yesOptionId);
    await admin.from("pools").update({ status: "LOCKED", locks_at: new Date(now - 60 * 1000).toISOString() }).eq("id", IDS.poolLocked);
  }
  log(`Pool 2 (LOCKED): ${p2.created ? "created" : "already existed — left untouched"}.`);

  // Pool 3 — AWAITING_RESULT against the COMPLETED fixture: 2 winners
  // (picked home win), 1 loser — a real mixed-settlement case ready for
  // the actual grading pipeline (gradeTemplatePool / process-results cron)
  // to be run against.
  const p3 = await getOrCreatePool(IDS.poolGradeable, gradeableFixture.id, adminId, "Will Dev Seed Home FC win?", new Date(now + 60 * 60 * 1000).toISOString());
  if (p3.created) {
    await enterPool(IDS.poolGradeable, alice, p3.yesOptionId);
    await enterPool(IDS.poolGradeable, bob, p3.noOptionId);
    await enterPool(IDS.poolGradeable, carol, p3.yesOptionId);
    await admin.from("pools").update({ status: "AWAITING_RESULT", locks_at: new Date(now - 60 * 1000).toISOString() }).eq("id", IDS.poolGradeable);
  }
  log(`Pool 3 (AWAITING_RESULT, ready to grade — home won 2-1): ${p3.created ? "created" : "already existed — left untouched"}.`);

  // Pool 4 — AWAITING_RESULT against the CANCELLED fixture: ready for the
  // automatic anomaly-refund path.
  const p4 = await getOrCreatePool(IDS.poolRefundable, cancelledFixture.id, adminId, "Will Dev Seed Home FC win?", new Date(now + 60 * 60 * 1000).toISOString());
  if (p4.created) {
    await enterPool(IDS.poolRefundable, alice, p4.yesOptionId);
    await enterPool(IDS.poolRefundable, bob, p4.noOptionId);
    await admin.from("pools").update({ status: "AWAITING_RESULT", locks_at: new Date(now - 60 * 1000).toISOString() }).eq("id", IDS.poolRefundable);
  }
  log(`Pool 4 (AWAITING_RESULT, ready for automatic refund — fixture cancelled): ${p4.created ? "created" : "already existed — left untouched"}.`);

  console.log("\nDone. Summary:");
  console.log(`  Open-eligible fixture for wizard testing: ${openEligibleFixture.id} (external_fixture_id: dev-seed-fixture-open-eligible)`);
  console.log(`  Pool 1 (OPEN, due to lock):      ${IDS.poolOpen}`);
  console.log(`  Pool 2 (LOCKED):                 ${IDS.poolLocked}`);
  console.log(`  Pool 3 (AWAITING_RESULT, grade): ${IDS.poolGradeable}`);
  console.log(`  Pool 4 (AWAITING_RESULT, refund): ${IDS.poolRefundable}`);
  console.log(
    "\nExercise the pipeline by hitting the cron routes locally (with CRON_SECRET set), e.g.:\n" +
      "  curl -H \"Authorization: Bearer $CRON_SECRET\" http://localhost:3000/api/cron/lock-pools\n" +
      "  curl -H \"Authorization: Bearer $CRON_SECRET\" http://localhost:3000/api/cron/process-results\n" +
      "or call lockDuePools()/processAwaitingResults() directly from a script/REPL.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
