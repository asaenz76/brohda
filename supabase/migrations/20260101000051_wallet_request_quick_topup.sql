-- Quick top-up: lets a player request a deposit "for" a specific pool entry
-- they couldn't otherwise afford. Both columns stay null for every ordinary
-- deposit/withdrawal request; approveWalletRequestAction only reads them
-- when present, to auto-complete the intended entry once funds land.
alter table public.wallet_requests
  add column intended_pool_id uuid references public.pools (id),
  add column intended_option_id uuid references public.pool_options (id);
