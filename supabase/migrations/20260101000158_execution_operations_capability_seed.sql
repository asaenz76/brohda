-- Continuation of 20260101000157 — see that migration's own comment.
-- Default policy for all three: super_admin only, same tier as every other
-- admin execution/diagnostic surface in this codebase. Changing it later is
-- a data change (`pnpm set-capability-policy`), never a source edit.
insert into public.capability_policies (capability, allowed_roles)
values
  ('view_execution_operations', array['super_admin']),
  ('manage_execution_controls', array['super_admin']),
  ('manage_execution_rollout', array['super_admin']);
