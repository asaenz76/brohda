-- Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Conversation).
-- Additive only. A dedicated `post_comments` domain — NOT a generalization
-- of `pool_comments` (R0.5's own finding, reconfirmed: pool comments are a
-- reusable PATTERN — ownership/RLS/RPC-authorization/one-level-nesting/
-- rate-limiting/moderation shape — not a table to stretch across two
-- unrelated products). Two deliberate departures from that pattern, both
-- explained where they occur below: soft-delete instead of hard-delete
-- (preserving reply structure), and a live-computed comment count instead
-- of a denormalized counter.

create table public.post_comments (
  id                 uuid primary key default gen_random_uuid(),
  -- Real, non-cascading FK — posts are permanent (R3: never deleted by any
  -- code path), the same reasoning that already justified markets.fixture_id
  -- and posts.fixture_id themselves. A Comment can never reference a Post
  -- that ceases to exist.
  post_id            uuid not null references public.posts (id),
  user_id            uuid not null references public.user_profiles (id) on delete cascade,
  -- One level of nesting only — mirrors pool_comments' own proven
  -- nesting_too_deep rule exactly (enforced in add_post_comment below, not
  -- just by convention, same as pool_comments).
  parent_comment_id  uuid references public.post_comments (id) on delete cascade,
  -- The hard technical ceiling only (defense in depth) — the actual
  -- enforced product-policy length is configurable
  -- (platform_settings.post_comment_max_length, read live inside
  -- add_post_comment below), not this fixed number. Deliberately higher
  -- than the 500-char default so tightening/loosening the configured
  -- policy never requires a migration.
  body               text not null check (char_length(body) between 1 and 2000),
  -- Soft-delete (tombstone), NOT pool_comments' hard-delete-with-cascade:
  -- a deliberate departure, not an oversight. This milestone's own
  -- instruction repeatedly warns against destroying reply structure by
  -- cascading a delete through a thread ("do NOT cascade-delete an entire
  -- conversation... unless that is explicitly intended product behavior");
  -- pool_comments does exactly that (verified: delete_pool_comment hard-
  -- deletes and cascades to every reply). A tombstoned row keeps its
  -- id/post_id/parent_comment_id/user_id/created_at intact — only `body`
  -- is presentationally replaced ("[comment deleted]") — so any reply
  -- underneath a removed top-level comment remains fully valid and
  -- visible, and a removed reply never orphans anything.
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),

  constraint post_comments_parent_not_self check (parent_comment_id is distinct from id)
);

create index idx_post_comments_post_id on public.post_comments (post_id, created_at);
create index idx_post_comments_parent_id on public.post_comments (parent_comment_id);

alter table public.post_comments enable row level security;

-- Comments inherit their Post's own read gate — published only — mirroring
-- pool_comments' "read_comments_on_readable_pools" precedent exactly,
-- adapted to Post's own publication boundary (posts.published_at is not
-- null) rather than pools.status != 'DRAFT'.
create policy "read_comments_on_published_posts"
on public.post_comments for select
to authenticated
using (
  exists (
    select 1 from public.posts p
    where p.id = post_comments.post_id
      and p.published_at is not null
  )
);

-- No INSERT/UPDATE/DELETE grant to authenticated at all — every write goes
-- through the two functions below via the service role
-- (lib/actions/post-comments.ts), matching every other "caller acts as
-- themselves" table already established in this codebase.
grant select on public.post_comments to authenticated;
grant select, insert, update on public.post_comments to service_role;

create or replace function public.add_post_comment(
  p_post_id uuid,
  p_user_id uuid,
  p_body text,
  p_parent_comment_id uuid default null
)
returns public.post_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.post_comments;
  v_parent public.post_comments;
  v_max_length integer;
begin
  -- Only a published Post accepts conversation — an unpublished Post's own
  -- RLS already hides it entirely, but this RPC (service-role, bypasses
  -- RLS) must not silently allow commenting on one anyway.
  if not exists (select 1 from public.posts where id = p_post_id and published_at is not null) then
    raise exception 'post_not_found';
  end if;

  select coalesce(post_comment_max_length, 500) into v_max_length from public.platform_settings where id = true;
  if char_length(p_body) > coalesce(v_max_length, 500) then
    raise exception 'body_too_long';
  end if;

  if p_parent_comment_id is not null then
    select * into v_parent from public.post_comments where id = p_parent_comment_id;
    if not found or v_parent.post_id != p_post_id then
      raise exception 'parent_not_found';
    end if;
    if v_parent.parent_comment_id is not null then
      raise exception 'nesting_too_deep';
    end if;
    -- A tombstoned parent still accepts replies (§13: removal must not
    -- invalidate the thread underneath it) — no additional check here.
  end if;

  insert into public.post_comments (post_id, user_id, body, parent_comment_id)
  values (p_post_id, p_user_id, p_body, p_parent_comment_id)
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.add_post_comment(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.add_post_comment(uuid, uuid, text, uuid) to service_role;

-- Soft-delete (see the table's own column comment for why this diverges
-- from delete_pool_comment's hard-delete+cascade). Same owner-or-admin
-- authority check pool_comments already proved (is_admin_or_above) — reused
-- directly rather than introducing a new capability-policy entry for this:
-- this is a check embedded in a user-facing action a normal user already
-- calls for their own row, the same shape pool_comments' own moderation
-- check already is, not a standalone admin-surface concern.
create or replace function public.remove_post_comment(p_comment_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comment public.post_comments;
begin
  select * into v_comment from public.post_comments where id = p_comment_id;
  if not found then
    return;
  end if;

  if v_comment.user_id != p_user_id and not public.is_admin_or_above(p_user_id) then
    raise exception 'not_authorized';
  end if;

  update public.post_comments set deleted_at = now() where id = p_comment_id and deleted_at is null;
end;
$$;

revoke all on function public.remove_post_comment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_post_comment(uuid, uuid) to service_role;

-- Notifications need a real link to the canonical Post (never a Community
-- copy — R4's own invariant) — mirrors notifications.pool_id's own real,
-- non-cascading FK exactly (posts are permanent, same as pools).
alter table public.notifications add column post_id uuid references public.posts (id);

-- Milestone R6 configurable policy — same platform_settings domain every
-- prior milestone's own additive policy columns already established.
alter table public.platform_settings
  add column post_comment_max_length integer not null default 500 check (post_comment_max_length >= 1 and post_comment_max_length <= 2000),
  add column post_comment_rate_limit_window_seconds integer not null default 60 check (post_comment_rate_limit_window_seconds >= 1),
  add column post_comment_rate_limit_max_attempts integer not null default 10 check (post_comment_rate_limit_max_attempts >= 1);

comment on column public.post_comments.deleted_at is
  'Soft-delete/tombstone marker — never a hard DELETE (see this table''s own migration header for why this deliberately diverges from pool_comments). Non-null means the comment is removed; the row, and any replies beneath it, remain structurally intact.';
comment on column public.platform_settings.post_comment_max_length is
  'The enforced product-policy comment length, read live by add_post_comment(). The post_comments.body CHECK constraint (2000) is a separate, higher, hard technical ceiling — defense in depth, not the product number.';
comment on column public.platform_settings.post_comment_rate_limit_window_seconds is
  'Post-comment rate-limit window, read by lib/rate-limit/post-comments.ts. Deliberately configurable, unlike pool_comments'' own hard-coded lib/rate-limit/comments.ts constants — not retrofitted onto the legacy table, only done correctly for this new one.';
comment on column public.platform_settings.post_comment_rate_limit_max_attempts is
  'Post-comment rate-limit attempt cap within the configured window — see post_comment_rate_limit_window_seconds.';
