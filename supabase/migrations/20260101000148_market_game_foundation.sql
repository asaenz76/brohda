-- Milestone R1 (docs/BROHDA_2_0_MILESTONE_MAP.md) — Game <-> Market
-- Foundation. Establishes the canonical, structurally-enforced relationship
-- between sports truth (`fixtures`, R0.5's verified Game object) and
-- objectively gradeable propositions (`markets`).
--
-- Referential integrity choice: a REAL foreign key to `fixtures.id`, not a
-- soft reference. This deliberately differs from `predictions.market_id`
-- (soft, by design — see 20260101000141_predictions.sql) because the two
-- cases are not analogous: `fixtures` rows are never deleted anywhere in
-- this codebase (verified: no `delete from fixtures` call exists; the
-- "fixture-archive" admin surface hides, it does not delete), and
-- `pools.fixture_id` already uses a plain, non-cascading FK to `fixtures`
-- as a proven precedent for exactly this relationship. A soft reference
-- exists to let history outlive a row that MIGHT disappear or be
-- restructured; `fixtures` never does either, so the extra durability cost
-- of a soft reference buys nothing here and a real FK gives genuine
-- integrity instead.
--
-- Market proposition identity: a Market row represents one immutable
-- proposition (`docs/BROHDA_2_0_MILESTONE_MAP.md` R1 §5-6). Sportsbook line
-- movement must never rewrite what an existing Pick meant, so the line
-- value, template, fixture, and side are structural identity columns,
-- enforced immutable by a trigger below — a moved line is a NEW Market row
-- (R2's concern to create; this migration only guarantees the old row can
-- never be silently mutated into meaning something else).
--
-- The `markets` table was empty in every environment this migration was
-- authored against (verified via `select count(*) from markets` before
-- writing this migration — see the R1 completion report), so every new
-- column below is added NOT NULL with no backfill required.

create type public.market_template as enum ('MONEYLINE', 'SPREAD', 'TOTAL');

alter table public.markets
  add column fixture_id uuid references public.fixtures (id),
  add column market_template public.market_template,
  -- Exact decimal, never float: a spread/total line like 6.5 must compare
  -- deterministically against an integer score sum, with no floating-point
  -- drift anywhere near proposition identity or grading.
  add column line_value numeric(6, 2),
  -- Which side of the fixture the YES outcome refers to. For TOTAL markets
  -- this is null by fixed template convention: YES always means OVER, NO
  -- always means UNDER (a true invariant of the TOTAL template itself, not
  -- configurable, not per-row data).
  add column yes_side text check (yes_side in ('HOME', 'AWAY'));

-- Brohda is sports-only (Milestone R0's repivot); every canonical Market
-- must belong to an authoritative Game. Set NOT NULL directly rather than
-- leaving it nullable "for a future non-sports provider" — R0.5 found no
-- such provider exists or is planned, and the table was verified empty.
alter table public.markets
  alter column fixture_id set not null,
  alter column market_template set not null;

-- Per-template shape: MONEYLINE has no line and needs a side; SPREAD needs
-- both a line and a side; TOTAL needs a line and no side (OVER/UNDER is
-- implicit). This is what makes "enough structural information to grade
-- deterministically" (R1 §9) a database guarantee, not a convention every
-- caller has to remember.
alter table public.markets add constraint markets_template_shape check (
  (market_template = 'MONEYLINE' and line_value is null and yes_side is not null)
  or (market_template = 'SPREAD' and line_value is not null and yes_side is not null)
  or (market_template = 'TOTAL' and line_value is not null and yes_side is null)
);

-- Proposition uniqueness (R1 §30): the same Game + template + line + side
-- must never exist as two different canonical Market rows. NULLs are
-- normalized via coalesce() because Postgres unique indexes otherwise treat
-- NULL <> NULL, which would let MONEYLINE (line_value always null) collide
-- silently. -1 and '' are safe sentinels: -1 is not a valid points line in
-- either sport's convention this codebase currently supports, and '' is not
-- a valid `yes_side` value (the check constraint above only allows
-- HOME/AWAY or null).
create unique index markets_sports_proposition_unique on public.markets (
  fixture_id, market_template, coalesce(line_value, -1), coalesce(yes_side, '')
);

create index idx_markets_fixture_id on public.markets (fixture_id);

-- Structural immutability (R1 §5, §31): once a proposition exists, its
-- identity can never change underneath an existing Pick. This is enforced
-- at the database level, not merely by application convention, mirroring
-- this codebase's existing forbid_audit_log_mutation()-style trigger
-- pattern for other permanent-identity data. Unlike that pattern, this is a
-- narrow field-level guard, not a whole-row freeze: `status`, prices,
-- `resolved_outcome`, and other mutable/diagnostic columns remain updatable
-- (upsertMarket's existing update-in-place behavior for price/status is
-- unaffected). A future ingestion pass that tries to change a line on an
-- existing row will fail loudly here, which is the intended outcome: it
-- must insert a new row instead.
create or replace function public.forbid_market_identity_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.fixture_id is distinct from old.fixture_id
    or new.market_template is distinct from old.market_template
    or new.line_value is distinct from old.line_value
    or new.yes_side is distinct from old.yes_side
  then
    raise exception 'markets.% identity columns (fixture_id, market_template, line_value, yes_side) are immutable once set; insert a new row instead of mutating an existing proposition', old.id;
  end if;
  return new;
end;
$$;

create trigger markets_forbid_identity_mutation
before update on public.markets
for each row execute function public.forbid_market_identity_mutation();

comment on column public.markets.fixture_id is
  'The canonical Game (R0.5: fixtures) this Market''s proposition is about. Real FK — fixtures are never deleted in this codebase. Immutable after insert (see markets_forbid_identity_mutation).';
comment on column public.markets.market_template is
  'MONEYLINE | SPREAD | TOTAL — the approved proposition families (docs/BROHDA_2_0_MILESTONE_MAP.md). Immutable after insert.';
comment on column public.markets.line_value is
  'The points line for SPREAD/TOTAL propositions (e.g. 6.5, 47.5). Null for MONEYLINE. Immutable after insert — a moved sportsbook line is a new Market row, never an update to this column.';
comment on column public.markets.yes_side is
  'HOME | AWAY: which fixture side the YES outcome refers to, for MONEYLINE/SPREAD. Always null for TOTAL, where YES means OVER by fixed template convention. Immutable after insert.';
