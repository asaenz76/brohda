// Brohda 2.1 M3 — Game Context inspection (development / staging). READ-ONLY: it runs the real loader over upcoming Games and prints each line with the stored Games that prove it.
//
//   node --conditions=react-server --import tsx scripts/game-context-inspect.mts [fixtureId ...]
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the database to inspect (the same variables the app uses). With no arguments it takes every upcoming Game with a published Post
// in the next 15 days. It writes nothing, and it prints the policy it ran with: if Game Context is OFF there, it says so and prints nothing else (turn it on there first, or read the lines on the feed).
import { createAdminClient } from "@/lib/supabase/admin";
import { getGameContextConfig, loadGameContexts } from "@/lib/game-context/repository";

const admin = createAdminClient();
const config = await getGameContextConfig();
console.error(`[game-context-inspect] ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host} · policy ${config.enabled ? "ON" : "OFF"}`);
if (!config.enabled) process.exit(0);

let ids = process.argv.slice(2);
if (ids.length === 0) {
  const now = new Date();
  const { data: posts } = await admin.from("posts").select("fixture_id").not("published_at", "is", null);
  const withPost = new Set((posts ?? []).map((p) => p.fixture_id));
  const { data: fixtures } = await admin
    .from("fixtures")
    .select("id")
    .eq("internal_status", "NOT_STARTED")
    .gte("scheduled_start_utc", now.toISOString())
    .lt("scheduled_start_utc", new Date(now.getTime() + 15 * 86_400_000).toISOString());
  ids = (fixtures ?? []).map((f) => f.id).filter((id) => withPost.has(id));
}

const { contexts, stats } = await loadGameContexts(ids, config);
const { data: rows } = await admin.from("fixtures").select("id, home_team_name, away_team_name, scheduled_start_utc, round").in("id", ids);
for (const f of rows ?? []) {
  const c = contexts.get(f.id);
  console.log(JSON.stringify({ fixtureId: f.id, game: `${f.away_team_name} at ${f.home_team_name}`, start: f.scheduled_start_utc, round: f.round, line: c?.text ?? null, shape: c?.metadata.shape ?? null, primary: c?.primaryFact ?? null, secondary: c?.secondaryFact ?? null, rank: c?.rank ?? null, supportingFixtureIds: c?.supportingFixtureIds ?? [] }));
}
console.error(`[game-context-inspect] ${ids.length} Games · ${contexts.size} with a line · ${stats.queries} queries · ${stats.rows} rows`);
