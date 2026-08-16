/**
 * Security invariant (incident containment, see
 * SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md): every privileged RPC in
 * `public` — money movement, settlement, refunds, pool entries, admin
 * mutations — must reject callers who aren't the role its own migration
 * grants it to. None of these functions check `auth.uid()` internally;
 * their only authorization boundary is the Postgres GRANT enforced by
 * PostgREST, so a widened grant is a full bypass of every Server Action
 * guard (requireUser/requireSuperAdmin/CRON_SECRET) sitting in front of
 * them. This table is generated from each function's own creating
 * migration (`revoke all ... grant execute ...`) — see
 * 20260101000107_security_incident_restore_rpc_privileges.sql. If a
 * future `CREATE OR REPLACE FUNCTION` or ad hoc GRANT reopens any of
 * these, this test fails.
 *
 * Run with: pnpm exec vitest run --config vitest.integration.config.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { url: SUPABASE_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

// Postgres's insufficient_privilege SQLSTATE — the permission check runs
// before the function body ever executes, so any type-valid placeholder
// argument fails at the boundary without touching real data (spec: never
// mutate money to "test" a permission gate).
const INSUFFICIENT_PRIVILEGE = "42501";

const PROTECTED_RPCS: Array<{
  name: string;
  args: Record<string, unknown>;
  allowAnon: boolean;
  allowAuthenticated: boolean;
}> = [
  { name: "abort_pool_reversal", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "add_pool_comment", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_user_id: "00000000-0000-0000-0000-000000000000", p_body: "test", p_parent_comment_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "advance_or_cancel_locked_pool", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "apply_wallet_transaction", args: { p_account_type: "user", p_user_id: "00000000-0000-0000-0000-000000000000", p_type: "manual_deposit", p_direction: "credit", p_amount: 1, p_admin_id: "00000000-0000-0000-0000-000000000000", p_reason: "test", p_idempotency_key: "test", p_pool_id: "00000000-0000-0000-0000-000000000000", p_entry_id: "00000000-0000-0000-0000-000000000000", p_settlement_id: "00000000-0000-0000-0000-000000000000", p_destination: "test" }, allowAnon: false, allowAuthenticated: false },
  { name: "can_view_pool_distribution", args: { p_pool_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "check_and_increment_rate_limit", args: { p_identifier: "test", p_window_seconds: 1, p_max_attempts: 1 }, allowAnon: true, allowAuthenticated: true },
  { name: "claim_import_job_chunks", args: { p_limit: 1, p_max_attempts: 1 }, allowAnon: false, allowAuthenticated: false },
  { name: "cleanup_import_job_chunk_payloads", args: { p_recovery_window: "1 hour" }, allowAnon: false, allowAuthenticated: false },
  { name: "close_own_account", args: { p_user_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "confirm_combo_refund_fee_retained", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000", p_grading_version: 1, p_idempotency_key: "test", p_winning_option_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "confirm_pool_refund", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_void_reason: "ADMIN_MANUAL_CANCEL", p_idempotency_key: "test", p_admin_id: "00000000-0000-0000-0000-000000000000", p_grading_version: 1 }, allowAnon: false, allowAuthenticated: false },
  { name: "confirm_pool_settlement", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000", p_grading_version: 1, p_idempotency_key: "test", p_winning_option_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "create_pool_entry", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_user_id: "00000000-0000-0000-0000-000000000000", p_option_id: "00000000-0000-0000-0000-000000000000", p_amount: 1, p_idempotency_key: "test" }, allowAnon: false, allowAuthenticated: false },
  { name: "delete_pool_comment", args: { p_comment_id: "00000000-0000-0000-0000-000000000000", p_user_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "delete_terminal_pool", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "get_branch_member_ids", args: { p_root_admin_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_competition_fixture_aggregates", args: { p_external_league_ids: [], p_terminal_statuses: [], p_activation_window_days: 1, p_recommendation_window_days: 1 }, allowAnon: false, allowAuthenticated: false },
  { name: "get_follow_counts", args: { p_user_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_followers", args: { p_user_id: "00000000-0000-0000-0000-000000000000", p_viewer_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_following", args: { p_user_id: "00000000-0000-0000-0000-000000000000", p_viewer_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_leaderboard", args: { p_scope: "test", p_range: "test", p_caller_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_pick_count", args: { p_user_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_platform_category_performance", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: false },
  { name: "get_platform_financial_overview", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: false },
  { name: "get_platform_monthly_activity", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z", p_granularity: "test", p_timezone: "test" }, allowAnon: false, allowAuthenticated: false },
  { name: "get_platform_overview", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: false },
  { name: "get_platform_top_users", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z", p_order: "test", p_limit: 1 }, allowAnon: false, allowAuthenticated: false },
  { name: "get_pool_participants", args: { p_pool_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_pool_participants_bulk", args: { p_pool_ids: [] }, allowAnon: false, allowAuthenticated: true },
  { name: "get_pool_totals", args: { p_pool_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_pool_totals_bulk", args: { p_pool_ids: [] }, allowAnon: false, allowAuthenticated: true },
  { name: "get_profile_stats", args: { p_user_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_stories_row", args: { p_viewer_id: "00000000-0000-0000-0000-000000000000", p_since: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_analytics_overview", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_bankroll_balance", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_category_performance", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_competition_performance", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_cumulative_pnl", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z", p_granularity: "test", p_timezone: "test" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_entry_history", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z", p_order: "test", p_limit: 1 }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_financial_overview", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z" }, allowAnon: false, allowAuthenticated: true },
  { name: "get_user_monthly_activity", args: { p_date_from: "2026-01-01T00:00:00Z", p_date_to: "2026-01-01T00:00:00Z", p_granularity: "test", p_timezone: "test" }, allowAnon: false, allowAuthenticated: true },
  { name: "is_admin_or_above", args: { uid: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "is_following", args: { p_follower_id: "00000000-0000-0000-0000-000000000000", p_followee_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "is_super_admin", args: { uid: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "prepare_pool_settlement", args: { p_pool_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "prepare_pool_settlement_manual", args: { p_pool_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "recalculate_import_job_progress", args: { p_job_id: "00000000-0000-0000-0000-000000000000", p_max_attempts: 1 }, allowAnon: false, allowAuthenticated: false },
  { name: "release_cron_lock", args: { p_job_name: "test" }, allowAnon: false, allowAuthenticated: false },
  { name: "reverse_pool_settlement", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000", p_reason: "test", p_idempotency_key: "test" }, allowAnon: false, allowAuthenticated: false },
  { name: "toggle_pool_like", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_user_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "try_acquire_cron_lock", args: { p_job_name: "test", p_ttl_seconds: 1 }, allowAnon: false, allowAuthenticated: false },
  { name: "undo_pool_grading", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: false },
  { name: "user_has_entered_pool", args: { p_pool_id: "00000000-0000-0000-0000-000000000000", p_user_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
  { name: "void_pool_entry", args: { p_entry_id: "00000000-0000-0000-0000-000000000000", p_admin_id: "00000000-0000-0000-0000-000000000000", p_reason: "test", p_idempotency_key: "test" }, allowAnon: false, allowAuthenticated: false },
  { name: "would_create_hierarchy_cycle", args: { p_subject_id: "00000000-0000-0000-0000-000000000000", p_parent_id: "00000000-0000-0000-0000-000000000000" }, allowAnon: false, allowAuthenticated: true },
];

describe.skipIf(!SERVICE_ROLE_KEY)("RPC privilege boundary (security incident containment)", () => {
  let anonClient: ReturnType<typeof createSupabaseClient>;
  let authenticatedClient: ReturnType<typeof createSupabaseClient>;
  let playerId: string;

  beforeAll(async () => {
    anonClient = createSupabaseClient(SUPABASE_URL, ANON_KEY);

    const email = `rpc-boundary-test-${Date.now()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "test-password-123",
      email_confirm: true,
    });
    if (error || !data.user) throw error ?? new Error("failed to create test player");
    playerId = data.user.id;

    await admin.from("user_profiles").insert({
      id: playerId,
      display_name: "rpc-boundary-test",
      role: "player",
      is_active: true,
    });

    authenticatedClient = createSupabaseClient(SUPABASE_URL, ANON_KEY);
    const { error: signInError } = await authenticatedClient.auth.signInWithPassword({
      email,
      password: "test-password-123",
    });
    if (signInError) throw signInError;
  });

  afterAll(async () => {
    await admin.from("user_profiles").update({ is_active: false }).eq("id", playerId);
  });

  // Untyped Database generic means TS can't resolve `.rpc()`'s overload for
  // a name pulled from a runtime table — the whole point of this file is
  // dynamic dispatch across 53 functions, so a targeted cast here stands in
  // for the per-call literal-name typing every other caller in the app uses.
  type DynamicRpc = (fn: string, args: Record<string, unknown>) => Promise<{ error: { code?: string } | null }>;

  for (const rpc of PROTECTED_RPCS) {
    it(`${rpc.allowAnon ? "allows" : "rejects"} anon calling ${rpc.name}`, async () => {
      const { error } = await (anonClient.rpc as unknown as DynamicRpc)(rpc.name, rpc.args);
      if (rpc.allowAnon) {
        expect(error?.code).not.toBe(INSUFFICIENT_PRIVILEGE);
      } else {
        expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });

    it(`${rpc.allowAuthenticated ? "allows" : "rejects"} an authenticated player calling ${rpc.name}`, async () => {
      const { error } = await (authenticatedClient.rpc as unknown as DynamicRpc)(rpc.name, rpc.args);
      if (rpc.allowAuthenticated) {
        expect(error?.code).not.toBe(INSUFFICIENT_PRIVILEGE);
      } else {
        expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  }

  it("still lets service_role call a protected RPC (sanity check the boundary isn't just failing closed for everyone)", async () => {
    const { error } = await (admin.rpc as unknown as DynamicRpc)("close_own_account", {
      p_user_id: "00000000-0000-0000-0000-000000000000",
    });
    // wallet_not_found is expected (nonsense user id) — the point is it's
    // NOT a permission error, proving service_role still has EXECUTE.
    expect(error?.code).not.toBe(INSUFFICIENT_PRIVILEGE);
  });
});
