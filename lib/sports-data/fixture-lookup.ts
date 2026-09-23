import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R1 (docs/BROHDA_2_0_MILESTONE_MAP.md): the minimal, focused read
// needed by sports Market grading (lib/predictions/sports-resolution.ts) —
// deliberately not a general-purpose fixtures repository. Fixture reads
// elsewhere in this codebase are scattered per call site by design (no
// single "fixtures repository" convention exists yet); this file exists
// only because grading needs exactly these four fields and nothing more.

export interface FixtureForGrading {
  id: string;
  internalStatus: string;
  homeScore: number | null;
  awayScore: number | null;
}

export async function getFixtureForGrading(id: string): Promise<FixtureForGrading | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("fixtures").select("id, internal_status, home_score, away_score").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    internalStatus: data.internal_status,
    homeScore: data.home_score,
    awayScore: data.away_score,
  };
}

// Milestone R3 (Post Foundation): the minimal read a Post detail surface
// needs to present its Game — team names, kickoff, competition, live
// status/score. A second narrow, explicitly-scoped function in this same
// file, not a general-purpose fixtures repository (this file's own header
// note still applies: fixture reads elsewhere in the codebase remain
// scattered per call site by design).
// Milestone R7 (Free Call BS Challenges): the minimal read the Call BS
// discovery surface needs — just the canonical kickoff, to compute the
// same effective Challenge cutoff set_pick()/call_bs() themselves
// authoritatively enforce (lib/predictions/lock.ts). A third narrow,
// explicitly-scoped function in this same file, per its own header note.
export async function getFixtureScheduledStart(id: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", id).maybeSingle();
  if (error) throw error;
  return data?.scheduled_start_utc ?? null;
}

export interface FixtureForPostPresentation {
  id: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  scheduledStartUtc: string;
  internalStatus: string;
  homeScore: number | null;
  awayScore: number | null;
}

export async function getFixtureForPostPresentation(id: string): Promise<FixtureForPostPresentation | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("fixtures")
    .select("id, home_team_name, away_team_name, competition_name, scheduled_start_utc, internal_status, home_score, away_score")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    homeTeamName: data.home_team_name,
    awayTeamName: data.away_team_name,
    competitionName: data.competition_name,
    scheduledStartUtc: data.scheduled_start_utc,
    internalStatus: data.internal_status,
    homeScore: data.home_score,
    awayScore: data.away_score,
  };
}
