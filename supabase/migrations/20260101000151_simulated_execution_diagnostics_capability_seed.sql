-- Continuation of 20260101000150 — see that migration's own comment.
-- Default policy: super_admin only, same tier as every other admin
-- diagnostic surface in this codebase. Changing it later is a data change
-- (`pnpm set-capability-policy --capability
-- view_simulated_execution_diagnostics --roles ...`), never a source edit.
insert into public.capability_policies (capability, allowed_roles)
values ('view_simulated_execution_diagnostics', array['super_admin']);
