-- Distinct from MANUAL_ADMIN_OVERRIDE (a human picked from the dropdown
-- with no structured evidence) — this reason means the winning option was
-- pre-stamped by lib/pools/templates/grade.ts's gradeTemplatePool from a
-- template's own deterministic gradingRule, with a pool_grading_evidence
-- row backing it. Own migration file per the ALTER TYPE transaction
-- constraint (see 20260101000057).
alter type public.winning_option_reason add value 'TEMPLATE_GRADED';
