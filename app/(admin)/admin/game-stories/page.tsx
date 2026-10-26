import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/guards";
import { LocalDateTime } from "@/components/LocalDateTime";
import { EditStoryForm, GenerateStoryForm, ReviewActions, StoryConfigForm } from "@/components/game-stories/AdminGameStoryTools";
import { credentialsConfigured } from "@/lib/game-stories/providers";
import { getMetrics, getStoryConfig, listRecentRuns, listReviewQueue, listUpcomingForAdmin } from "@/lib/game-stories/repository";

export const dynamic = "force-dynamic";
// "Research now" runs the whole pipeline (research, drafting, verification, scoring) inside this page's route, which can take a couple of minutes.
export const maxDuration = 300;

// Admin: the editorial review desk for AI-researched Game stories. Candidates are produced by the engine and NEVER reach a Post until an Admin approves them here. Each candidate shows the evidence it rests on, the atomic claims and
// which sources support which, the score by dimension, the model and prompt version, and why anything was rejected. Settings (Super Admin) include the kill switch.
const DAYS = 7;

export default async function AdminGameStoriesPage() {
  const user = await requireAdminOrAbove();
  const config = await getStoryConfig();
  const [metrics, queue, runs, upcoming] = await Promise.all([getMetrics(DAYS), listReviewQueue(), listRecentRuns(40), listUpcomingForAdmin(config.supportedSports, 30)]);
  const ms = (v: number | null | undefined) => (v ? `${(v / 1000).toFixed(1)}s` : "–");

  return (
    <div className="space-y-6" data-slot="admin-game-stories">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-text-primary">Game Stories</h1>
        <p className="text-sm text-text-secondary">
          Researched, fact-checked, scored candidate stories for upcoming Games. A story reaches a Post only when you approve it. Generation is <strong className="text-text-primary">{config.generationEnabled ? "ON" : "OFF"}</strong>; automatic publishing is locked off.
        </p>
      </div>

      <section className="space-y-2" aria-label="Last 7 days" data-slot="story-metrics">
        <h2 className="text-sm font-semibold text-text-primary">Last {DAYS} days</h2>
        <p className="text-sm text-text-secondary">
          {metrics.games_researched ?? 0} Games researched · {metrics.accepted ?? 0} candidates for review · {metrics.rejected ?? 0} rejected ({metrics.rejected_unsupported ?? 0} unsupported or unverifiable facts, {metrics.rejected_low_score ?? 0} low score) · {metrics.no_story ?? 0} with no story ·{" "}
          {metrics.failed ?? 0} failed · average score {metrics.avg_score ?? "–"} · average sources {metrics.avg_sources ?? "–"} · average run {ms(metrics.avg_elapsed_ms)} (slowest {ms(metrics.max_elapsed_ms)}) · {metrics.model_calls ?? 0} model calls, {metrics.search_calls ?? 0} searches,{" "}
          {Number(metrics.input_tokens ?? 0).toLocaleString()} tokens in / {Number(metrics.output_tokens ?? 0).toLocaleString()} out.
        </p>
      </section>

      <section className="space-y-3" aria-label="Waiting for review" data-slot="review-queue">
        <h2 className="text-sm font-semibold text-text-primary">Waiting for your review ({queue.length})</h2>
        {queue.length === 0 && <p className="text-sm text-text-muted">Nothing is waiting.</p>}
        {queue.map((r) => (
          <article key={r.id} className="space-y-3 rounded-md border border-border-subtle p-3" data-slot="review-item">
            <div className="space-y-1">
              <p className="text-lg font-semibold leading-snug text-text-primary">{r.hook}</p>
              <p className="text-[15px] leading-relaxed text-text-secondary">{r.body}</p>
              <p className="text-xs text-text-muted">
                {r.char_count}/{config.maxChars} characters · score {r.total_score ?? "–"}/100 · {r.source === "ADMIN_EDIT" ? "edited by an Admin" : "generated"}
                {r.requires_verification ? " · needs re-verification" : ""} ·{" "}
                {r.run_id && (
                  <Link href={`/admin/game-stories/${r.run_id}`} className="underline">
                    evidence, claims and scores
                  </Link>
                )}
              </p>
            </div>
            <ReviewActions revisionId={r.id} requiresVerification={Boolean(r.requires_verification)} />
            <details>
              <summary className="cursor-pointer text-xs text-text-muted">Edit the words</summary>
              <div className="pt-2">
                <EditStoryForm revisionId={r.id} hook={r.hook} body={r.body} maxChars={config.maxChars} />
              </div>
            </details>
          </article>
        ))}
      </section>

      <section className="space-y-2" aria-label="Upcoming Games" data-slot="upcoming-games">
        <h2 className="text-sm font-semibold text-text-primary">Upcoming Games ({upcoming.length})</h2>
        <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
          {upcoming.map((g) => {
            const post = Array.isArray(g.posts) ? g.posts[0] : g.posts;
            const latest = g.latestRun as { status: string; decision: string | null; rejection_code: string | null; total_score: number | null } | null;
            return (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-text-primary">
                    {g.away_team_name} @ {g.home_team_name}
                  </p>
                  <p className="text-xs text-text-muted">
                    <LocalDateTime iso={g.scheduled_start_utc} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> · {post?.story_revision_id ? "has an approved story" : "no story"} ·{" "}
                    {latest ? `last run ${latest.status.toLowerCase().replace("_", " ")}${latest.rejection_code ? ` (${latest.rejection_code})` : ""}${latest.total_score != null ? ` ${latest.total_score}/100` : ""}` : "never researched"}
                  </p>
                </div>
                <GenerateStoryForm fixtureId={g.id} regenerate={Boolean(latest)} label={latest ? "Regenerate" : "Research now"} />
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-2" aria-label="Recent runs" data-slot="recent-runs">
        <h2 className="text-sm font-semibold text-text-primary">Recent runs</h2>
        <ul className="space-y-1 text-xs text-text-muted">
          {runs.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/game-stories/${r.id}`} className="underline">
                {new Date(r.started_at).toUTCString()}
              </Link>{" "}
              · {r.trigger_kind.toLowerCase()} · {r.status.toLowerCase().replace("_", " ")}
              {r.decision ? ` · ${r.decision.toLowerCase().replace("_", " ")}` : ""}
              {r.rejection_code ? ` (${r.rejection_code})` : ""}
              {r.total_score != null ? ` · ${r.total_score}/100` : ""} · {r.sources_kept} sources · {ms(r.elapsed_ms)}
              {r.error_category ? ` · ${r.error_category}` : ""}
            </li>
          ))}
        </ul>
      </section>

      {isSuperAdmin(user) && (
        <section className="space-y-2" aria-label="Settings" data-slot="story-settings">
          <h2 className="text-sm font-semibold text-text-primary">Settings (Super Admin)</h2>
          <StoryConfigForm config={config} credentialsConfigured={credentialsConfigured()} />
        </section>
      )}
    </div>
  );
}
