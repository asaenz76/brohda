-- Records which exact template version produced a grading result — matters
-- once a template can have more than one version (gradeTemplatePool always
-- resolves the pool's own stored template_version, never "whatever's
-- latest now"), so the audit trail should say which one actually ran.
-- Nullable: existing rows predate versioning and stay null (equivalent to
-- version 1, the only version that existed at the time).
alter table public.pool_grading_evidence add column template_version integer;
