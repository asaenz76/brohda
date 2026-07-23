# brohda.

A private, invite-only sports pool platform for small friend groups. Invited
users pay a fixed entry fee, pick one outcome on a curated soccer fixture,
and split the prize pool with everyone who picked the winning outcome — no
odds, no sportsbook, no exposure for the house beyond a transparent
coordinator fee.

Built with Next.js 16 (App Router), TypeScript, Supabase (Postgres + Auth +
RLS), and Tailwind CSS v4 + shadcn/ui.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it's built, and
[docs/ACCEPTANCE_CRITERIA.md](docs/ACCEPTANCE_CRITERIA.md) for the spec
acceptance-criteria audit. For deploying to production, see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (for the local Supabase stack)
- The [Supabase CLI](https://supabase.com/docs/guides/cli) (installed as a dev dependency, invoked via `pnpm`)

## Local setup

```bash
pnpm install
pnpm supabase:start             # starts local Postgres/Auth/Storage via Docker, applies migrations
cp .env.example .env.local      # fill in the keys `supabase start` printed
pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
pnpm seed                       # optional — demo players + pools in every status
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and log in with the
super-admin credentials above (or a seeded demo account — see
`scripts/seed.ts`'s output for emails; password is `PollPoolsDemo123!`).

Admin pages live under `/admin/*` (users, invitations, fixtures, pools,
reports, audit log) and require the super-admin account.

## Testing

```bash
pnpm test               # unit tests — no live Supabase needed
pnpm test:integration   # RLS, wallet, pools/entries, settlement, reversal — requires `pnpm supabase:start`
pnpm test:e2e           # Playwright — requires local Supabase + SUPABASE_SERVICE_ROLE_KEY
pnpm lint
pnpm exec tsc --noEmit
```

## Seeding demo data

`pnpm seed` populates a freshly reset database with 5 demo players and 10
pools spanning every reachable pool status (open, locked, awaiting result,
ready for review, settled — including one with a rounding remainder — voided,
cancelled, and one reversed settlement), plus wallet transactions exercising
every transaction type. It reuses the app's real RPCs (`create_pool_entry`,
`prepare_pool_settlement`, `confirm_pool_settlement`, `confirm_pool_refund`,
`reverse_pool_settlement`, `apply_wallet_transaction`), so seeded data obeys
the same invariants real traffic does.

It is **not idempotent** — run it once against a freshly reset database,
after `pnpm create-super-admin`:

```bash
pnpm supabase:reset
pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
pnpm seed
```

Never run `pnpm seed` against a production database — see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
