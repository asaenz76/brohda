/**
 * Developer inspection tool for the `markets` table
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 1, STEP 16). Read-only.
 * Deliberately a plain CLI script, not an admin UI page — Milestone 1 has
 * no consumer or admin-facing surface, and this table has no product
 * behavior yet to justify one.
 *
 * Usage: pnpm inspect-prediction-markets [--status=ACTIVE] [--limit=20]
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const statusArg = process.argv.find((a) => a.startsWith("--status="))?.split("=")[1];
const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const limit = limitArg ? Number.parseInt(limitArg, 10) : 20;

async function main() {
  const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let query = admin
    .from("markets")
    .select(
      "provider, provider_market_id, question, status, yes_price, no_price, liquidity, volume_24hr, closes_at, last_synced_at, ingestion_source",
    )
    .order("last_synced_at", { ascending: false })
    .limit(limit);

  if (statusArg) query = query.eq("status", statusArg);

  const { data, error } = await query;
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log("No markets found.");
    return;
  }

  for (const row of data) {
    console.log(`\n[${row.provider}] ${row.provider_market_id} — ${row.status}`);
    console.log(`  Q: ${row.question}`);
    console.log(`  YES: ${row.yes_price ?? "n/a"}  NO: ${row.no_price ?? "n/a"}`);
    console.log(`  liquidity: ${row.liquidity ?? "n/a"}  volume24hr: ${row.volume_24hr ?? "n/a"}`);
    console.log(`  closes_at: ${row.closes_at ?? "n/a"}`);
    console.log(`  last_synced_at: ${row.last_synced_at}`);
    console.log(`  ingestion_source: ${row.ingestion_source}`);
  }

  console.log(`\n${data.length} market(s) shown.`);
}

main();
