-- Security incident containment: production drifted from every function's
-- migration-defined privilege model (see git history — each function below
-- already had an explicit `revoke all ... grant execute ...` statement in its
-- own creating/hardening migration). Live production somehow ended up with
-- anon/authenticated/PUBLIC EXECUTE on every public-schema function regardless
-- of that intent (confirmed via diff against a clean local rebuild of the same
-- migration files, which shows the correct narrow grants) — most likely an
-- out-of-band `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public` run directly
-- against production outside the migration history. This migration is the
-- single source of truth going forward: it restores every function to exactly
-- what its own history already specified, so `supabase db push` alone can no
-- longer silently coexist with a wider live grant. Seven trigger/event-trigger
-- functions (enforce_pool_fee_immutability, enforce_pool_option_semantics_immutability,
-- forbid_audit_log_mutation, forbid_pool_grading_evidence_mutation, rls_auto_enable,
-- set_updated_at, validate_admin_hierarchy) are intentionally left untouched —
-- verified via pg_get_function_result to return `trigger`/`event_trigger`, which
-- Postgres refuses to invoke outside trigger context regardless of EXECUTE grants.

revoke execute on function public.abort_pool_reversal(p_pool_id uuid, p_admin_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.abort_pool_reversal(p_pool_id uuid, p_admin_id uuid) to service_role;

revoke execute on function public.add_pool_comment(p_pool_id uuid, p_user_id uuid, p_body text, p_parent_comment_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.add_pool_comment(p_pool_id uuid, p_user_id uuid, p_body text, p_parent_comment_id uuid) to service_role;

revoke execute on function public.advance_or_cancel_locked_pool(p_pool_id uuid, p_admin_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.advance_or_cancel_locked_pool(p_pool_id uuid, p_admin_id uuid) to service_role;

revoke execute on function public.apply_wallet_transaction(p_account_type wallet_account_type, p_user_id uuid, p_type wallet_transaction_type, p_direction wallet_direction, p_amount bigint, p_admin_id uuid, p_reason text, p_idempotency_key text, p_pool_id uuid, p_entry_id uuid, p_settlement_id uuid, p_destination text) from public, anon, authenticated, service_role;
grant execute on function public.apply_wallet_transaction(p_account_type wallet_account_type, p_user_id uuid, p_type wallet_transaction_type, p_direction wallet_direction, p_amount bigint, p_admin_id uuid, p_reason text, p_idempotency_key text, p_pool_id uuid, p_entry_id uuid, p_settlement_id uuid, p_destination text) to service_role;

revoke execute on function public.can_view_pool_distribution(p_pool_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.can_view_pool_distribution(p_pool_id uuid) to authenticated, service_role;

revoke execute on function public.check_and_increment_rate_limit(p_identifier text, p_window_seconds integer, p_max_attempts integer) from public, anon, authenticated, service_role;
grant execute on function public.check_and_increment_rate_limit(p_identifier text, p_window_seconds integer, p_max_attempts integer) to anon, authenticated, service_role;

revoke execute on function public.claim_import_job_chunks(p_limit integer, p_max_attempts integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_import_job_chunks(p_limit integer, p_max_attempts integer) to service_role;

revoke execute on function public.cleanup_import_job_chunk_payloads(p_recovery_window interval) from public, anon, authenticated, service_role;
grant execute on function public.cleanup_import_job_chunk_payloads(p_recovery_window interval) to service_role;

revoke execute on function public.close_own_account(p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.close_own_account(p_user_id uuid) to service_role;

revoke execute on function public.confirm_combo_refund_fee_retained(p_pool_id uuid, p_admin_id uuid, p_grading_version integer, p_idempotency_key text, p_winning_option_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.confirm_combo_refund_fee_retained(p_pool_id uuid, p_admin_id uuid, p_grading_version integer, p_idempotency_key text, p_winning_option_id uuid) to service_role;

revoke execute on function public.confirm_pool_refund(p_pool_id uuid, p_void_reason pool_void_reason, p_idempotency_key text, p_admin_id uuid, p_grading_version integer) from public, anon, authenticated, service_role;
grant execute on function public.confirm_pool_refund(p_pool_id uuid, p_void_reason pool_void_reason, p_idempotency_key text, p_admin_id uuid, p_grading_version integer) to service_role;

revoke execute on function public.confirm_pool_settlement(p_pool_id uuid, p_admin_id uuid, p_grading_version integer, p_idempotency_key text, p_winning_option_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.confirm_pool_settlement(p_pool_id uuid, p_admin_id uuid, p_grading_version integer, p_idempotency_key text, p_winning_option_id uuid) to service_role;

revoke execute on function public.create_pool_entry(p_pool_id uuid, p_user_id uuid, p_option_id uuid, p_amount bigint, p_idempotency_key text) from public, anon, authenticated, service_role;
grant execute on function public.create_pool_entry(p_pool_id uuid, p_user_id uuid, p_option_id uuid, p_amount bigint, p_idempotency_key text) to service_role;

revoke execute on function public.create_wallet_for_new_profile() from public, anon, authenticated, service_role;

revoke execute on function public.delete_pool_comment(p_comment_id uuid, p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_pool_comment(p_comment_id uuid, p_user_id uuid) to service_role;

revoke execute on function public.delete_terminal_pool(p_pool_id uuid, p_admin_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_terminal_pool(p_pool_id uuid, p_admin_id uuid) to service_role;

revoke execute on function public.get_branch_member_ids(p_root_admin_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_branch_member_ids(p_root_admin_id uuid) to authenticated, service_role;

revoke execute on function public.get_competition_fixture_aggregates(p_external_league_ids text[], p_terminal_statuses text[], p_activation_window_days integer, p_recommendation_window_days integer) from public, anon, authenticated, service_role;
grant execute on function public.get_competition_fixture_aggregates(p_external_league_ids text[], p_terminal_statuses text[], p_activation_window_days integer, p_recommendation_window_days integer) to service_role;

revoke execute on function public.get_follow_counts(p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_follow_counts(p_user_id uuid) to authenticated, service_role;

revoke execute on function public.get_followers(p_user_id uuid, p_viewer_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_followers(p_user_id uuid, p_viewer_id uuid) to authenticated, service_role;

revoke execute on function public.get_following(p_user_id uuid, p_viewer_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_following(p_user_id uuid, p_viewer_id uuid) to authenticated, service_role;

revoke execute on function public.get_leaderboard(p_scope text, p_range text, p_caller_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_leaderboard(p_scope text, p_range text, p_caller_id uuid) to authenticated, service_role;

revoke execute on function public.get_pick_count(p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_pick_count(p_user_id uuid) to authenticated, service_role;

revoke execute on function public.get_platform_category_performance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_platform_category_performance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to service_role;

revoke execute on function public.get_platform_financial_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_platform_financial_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to service_role;

revoke execute on function public.get_platform_monthly_activity(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_granularity text, p_timezone text) from public, anon, authenticated, service_role;
grant execute on function public.get_platform_monthly_activity(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_granularity text, p_timezone text) to service_role;

revoke execute on function public.get_platform_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_platform_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to service_role;

revoke execute on function public.get_platform_top_users(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_order text, p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.get_platform_top_users(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_order text, p_limit integer) to service_role;

revoke execute on function public.get_pool_participants(p_pool_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_pool_participants(p_pool_id uuid) to authenticated, service_role;

revoke execute on function public.get_pool_participants_bulk(p_pool_ids uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_pool_participants_bulk(p_pool_ids uuid[]) to authenticated, service_role;

revoke execute on function public.get_pool_totals(p_pool_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_pool_totals(p_pool_id uuid) to authenticated, service_role;

revoke execute on function public.get_pool_totals_bulk(p_pool_ids uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_pool_totals_bulk(p_pool_ids uuid[]) to authenticated, service_role;

revoke execute on function public.get_profile_stats(p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_profile_stats(p_user_id uuid) to authenticated, service_role;

revoke execute on function public.get_stories_row(p_viewer_id uuid, p_since timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_stories_row(p_viewer_id uuid, p_since timestamp with time zone) to authenticated, service_role;

revoke execute on function public.get_user_analytics_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_user_analytics_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to authenticated, service_role;

revoke execute on function public.get_user_bankroll_balance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_user_bankroll_balance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to authenticated, service_role;

revoke execute on function public.get_user_category_performance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_user_category_performance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to authenticated, service_role;

revoke execute on function public.get_user_competition_performance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_user_competition_performance(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to authenticated, service_role;

revoke execute on function public.get_user_cumulative_pnl(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_granularity text, p_timezone text) from public, anon, authenticated, service_role;
grant execute on function public.get_user_cumulative_pnl(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_granularity text, p_timezone text) to authenticated, service_role;

revoke execute on function public.get_user_entry_history(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_order text, p_limit integer) from public, anon, authenticated, service_role;
grant execute on function public.get_user_entry_history(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_order text, p_limit integer) to authenticated, service_role;

revoke execute on function public.get_user_financial_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.get_user_financial_overview(p_date_from timestamp with time zone, p_date_to timestamp with time zone) to authenticated, service_role;

revoke execute on function public.get_user_monthly_activity(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_granularity text, p_timezone text) from public, anon, authenticated, service_role;
grant execute on function public.get_user_monthly_activity(p_date_from timestamp with time zone, p_date_to timestamp with time zone, p_granularity text, p_timezone text) to authenticated, service_role;

revoke execute on function public.is_admin_or_above(uid uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_admin_or_above(uid uuid) to authenticated, service_role;

revoke execute on function public.is_following(p_follower_id uuid, p_followee_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_following(p_follower_id uuid, p_followee_id uuid) to authenticated, service_role;

revoke execute on function public.is_super_admin(uid uuid) from public, anon, authenticated, service_role;
grant execute on function public.is_super_admin(uid uuid) to authenticated, service_role;

revoke execute on function public.prepare_pool_settlement(p_pool_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.prepare_pool_settlement(p_pool_id uuid) to service_role;

revoke execute on function public.prepare_pool_settlement_manual(p_pool_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.prepare_pool_settlement_manual(p_pool_id uuid) to service_role;

revoke execute on function public.recalculate_import_job_progress(p_job_id uuid, p_max_attempts integer) from public, anon, authenticated, service_role;
grant execute on function public.recalculate_import_job_progress(p_job_id uuid, p_max_attempts integer) to service_role;

revoke execute on function public.reverse_pool_settlement(p_pool_id uuid, p_admin_id uuid, p_reason text, p_idempotency_key text) from public, anon, authenticated, service_role;
grant execute on function public.reverse_pool_settlement(p_pool_id uuid, p_admin_id uuid, p_reason text, p_idempotency_key text) to service_role;

revoke execute on function public.toggle_pool_like(p_pool_id uuid, p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.toggle_pool_like(p_pool_id uuid, p_user_id uuid) to service_role;

revoke execute on function public.undo_pool_grading(p_pool_id uuid, p_admin_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.undo_pool_grading(p_pool_id uuid, p_admin_id uuid) to service_role;

revoke execute on function public.user_has_entered_pool(p_pool_id uuid, p_user_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.user_has_entered_pool(p_pool_id uuid, p_user_id uuid) to authenticated, service_role;

revoke execute on function public.void_pool_entry(p_entry_id uuid, p_admin_id uuid, p_reason text, p_idempotency_key text) from public, anon, authenticated, service_role;
grant execute on function public.void_pool_entry(p_entry_id uuid, p_admin_id uuid, p_reason text, p_idempotency_key text) to service_role;

revoke execute on function public.would_create_hierarchy_cycle(p_subject_id uuid, p_parent_id uuid) from public, anon, authenticated, service_role;
grant execute on function public.would_create_hierarchy_cycle(p_subject_id uuid, p_parent_id uuid) to authenticated, service_role;
