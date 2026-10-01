import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export interface LandingStats {
  betaTesters: number;
  predictionsMade: number;
  gamesTracked: number;
}

export interface LandingPageData {
  stats: LandingStats;
}

export async function getLandingPageData(): Promise<LandingPageData> {
  const admin = createAdminClient();

  const [{ count: betaTesters }, { count: predictionsMade }, { count: gamesTracked }] = await Promise.all([
    admin
      .from("user_profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "player")
      .eq("is_active", true),
    admin.from("entries").select("id", { count: "exact", head: true }),
    admin.from("posts").select("id", { count: "exact", head: true }).not("published_at", "is", null),
  ]);

  return {
    stats: {
      betaTesters: betaTesters ?? 0,
      predictionsMade: predictionsMade ?? 0,
      gamesTracked: gamesTracked ?? 0,
    },
  };
}
