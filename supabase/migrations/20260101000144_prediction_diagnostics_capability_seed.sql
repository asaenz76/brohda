-- Milestone 3 final standing-rule remediation, Finding 1 (continued from
-- 20260101000143 — see that migration's own comment for why this is
-- split into a second migration). Seeds the default policy: super_admin
-- only, the same tier as every other admin-diagnostic surface in this
-- codebase. Changing this later is a data change
-- (`pnpm set-capability-policy --capability view_prediction_diagnostics
-- --roles ...`), never a source edit or deployment.
insert into public.capability_policies (capability, allowed_roles)
values ('view_prediction_diagnostics', array['super_admin']);
