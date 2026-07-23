-- New shared pool_type for every registry-driven template (Phase 1 of the
-- pool-template expansion). One value covers all future templates instead
-- of a new enum value per template — the specific template is identified
-- by pools.template_id/template_config (added in the next migration), not
-- by pool_type itself. ALTER TYPE ... ADD VALUE can't run in the same
-- transaction that creates the type (and each migration file is its own
-- transaction), hence this is its own file, matching how CUSTOM/COMBO were
-- each added.
alter type public.pool_type add value 'TEMPLATE_GRADED';
