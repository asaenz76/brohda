import { requireSuperAdmin } from "@/lib/auth/session";
import { LocalDateTime } from "@/components/LocalDateTime";
import { EditPreviewForm, GamePreviewConfigForm, GeneratePreviewForm, WithdrawPreviewForm } from "@/components/game-previews/AdminGamePreviewTools";
import { getGamePreviewConfig, getGenerationUsageSummary, listGamePreviewCandidates, listGamePreviewsForAdmin, listRecentGenerationRuns, listUpcomingGamesForAdmin } from "@/lib/game-previews/repository";

export const dynamic = "force-dynamic";
// Generating a Preview researches the web and writes with a model, which can take minutes: the explicit Generate action runs inside this page's route.
export const maxDuration = 300;

// Super Admin only. The editorial side of the Game Post: which upcoming Games have a Game Preview, which still need one (missing or stale), what each Preview says and exactly which sources it rests on, and the limits and timings
// (stored configuration, nothing is a constant in code). Previews are researched and written ahead of time and saved; nothing here — or on the Post — researches or generates anything when a page is opened.
const SHOW_DAYS = 14;

export default async function AdminGamePreviewsPage() {
  await requireSuperAdmin();
  const [config, candidates, usage, runs] = await Promise.all([getGamePreviewConfig(), listGamePreviewCandidates(), getGenerationUsageSummary(), listRecentGenerationRuns(8)]);
  // Presence only — the key itself is never read into the page.
  const credentialsConfigured = config.provider === "anthropic" && Boolean(process.env.ANTHROPIC_API_KEY);
  const games = await listUpcomingGamesForAdmin(SHOW_DAYS);
  const previews = await listGamePreviewsForAdmin(games.map((g) => g.fixtureId));
  const needs = new Map(candidates.map((c) => [c.fixtureId, c.reason]));

  return (
    <div className="space-y-6" data-slot="admin-game-previews">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-text-primary">Game Previews</h1>
        <p className="text-sm text-text-secondary">
          The hook and short story Members read on a Game&apos;s Post. They are written ahead of time from verified sources and saved here; the Post only reads what is saved. Once a Game starts its Preview is frozen.
        </p>
      </div>

      <section className="space-y-2" aria-label="Summary">
        <p className="text-sm text-text-secondary" data-slot="preview-summary">
          Next {SHOW_DAYS} days: <strong className="text-text-primary">{games.length}</strong> published Games · <strong className="text-text-primary">{games.filter((g) => previews.get(g.fixtureId)?.status === "PUBLISHED").length}</strong> with a Preview ·{" "}
          <strong className="text-text-primary">{candidates.length}</strong> need one now (starting within {config.leadHours}h and missing or stale).
        </p>
      </section>

      <section className="space-y-2" aria-label="Generation usage" data-slot="generation-usage">
        <h2 className="text-sm font-semibold text-text-primary">Generation usage</h2>
        <p className="text-sm text-text-secondary">
          {usage.gamesResearched} Games researched · {usage.succeeded} Previews written · {usage.failed + usage.rejected} not saved ({usage.rejected} rejected by the checks) · {usage.regenerations} regenerations · {usage.searchCalls} web searches · {usage.modelCalls} model calls
          {usage.avgCallsPerSuccessfulPreview !== null && <> · {usage.avgCallsPerSuccessfulPreview} calls per Preview</>} · {usage.inputTokens.toLocaleString("en-US")} tokens in, {usage.outputTokens.toLocaleString("en-US")} out
          {usage.byProviderModel.length > 0 && <> · {usage.byProviderModel.map((m) => `${m.provider} ${m.model} ×${m.runs}`).join(", ")}</>}
        </p>
        {runs.length > 0 && (
          <ul className="space-y-1.5 text-xs text-text-muted" data-slot="generation-runs">
            {runs.map((r) => {
              const d = r.details as { sources?: { reached: number; accepted: number; rejected: number }; facts?: unknown[]; angles?: Array<{ id: string; type: string; summary: string; scores: Record<string, number> }>; chosenAngleId?: string | null; selectedAngleId?: string | null; angleOverridden?: boolean; selectionReason?: string; rejectedAngles?: Array<{ id: string; reason: string }>; attemptsLog?: Array<{ attempt: number; hook: string; provenanceProblems: string[]; editorialProblems: string[]; verifierProblems: string[] }>; rewrites?: number };
              return (
                <li key={r.id}>
                  {new Date(r.startedAt).toUTCString()} · {r.trigger.toLowerCase()} · {r.reason} · <strong className="text-text-secondary">{r.status}</strong> · {r.model || "no model"}
                  {r.effort && <> · effort {r.effort}</>} · {r.searchCalls} searches · {r.modelCalls} model calls
                  {r.error && <> — {r.error}</>}
                  {d.angles && d.angles.length > 0 && (
                    <details className="mt-1" data-slot="run-details">
                      <summary className="cursor-pointer font-medium text-text-secondary">What it found and decided</summary>
                      <div className="mt-1 space-y-1">
                        <p>
                          Sources: {d.sources?.reached ?? 0} reached, {d.sources?.accepted ?? 0} used, {d.sources?.rejected ?? 0} not used · {d.facts?.length ?? 0} facts · {d.rewrites ?? 0} rewrite(s) · tool {r.toolVersion}
                        </p>
                        <p>
                          Chosen story: <strong className="text-text-secondary">{d.angles.find((a) => a.id === d.chosenAngleId)?.summary}</strong> ({d.angles.find((a) => a.id === d.chosenAngleId)?.type})
                          {d.angleOverridden && <> — a records-only choice was overridden. {d.selectionReason}</>}
                        </p>
                        <ul>
                          {d.angles.map((a) => (
                            <li key={a.id}>
                              {a.id === d.chosenAngleId ? "✓ " : "· "}
                              {a.type}: {a.summary} — T{a.scores.tension} S{a.scores.surprise} Sp{a.scores.specificity} H{a.scores.humanInterest} C{a.scores.conversation} R{a.scores.recency}
                            </li>
                          ))}
                        </ul>
                        {(d.attemptsLog ?? []).map((a) => (
                          <p key={a.attempt}>
                            Attempt {a.attempt}: “{a.hook}” — {[...a.provenanceProblems, ...a.editorialProblems, ...a.verifierProblems].length === 0 ? "accepted" : [...a.provenanceProblems, ...a.editorialProblems, ...a.verifierProblems].join(" · ")}
                          </p>
                        ))}
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-label="Settings">
        <h2 className="text-sm font-semibold text-text-primary">Limits and timings</h2>
        <GamePreviewConfigForm config={config} credentialsConfigured={credentialsConfigured} />
      </section>

      <section className="space-y-3" aria-label="Upcoming Games">
        <h2 className="text-sm font-semibold text-text-primary">Upcoming Games</h2>
        {games.length === 0 ? (
          <p className="text-sm text-text-muted">No published Games in the next {SHOW_DAYS} days.</p>
        ) : (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
            {games.map((g) => {
              const p = previews.get(g.fixtureId);
              const need = needs.get(g.fixtureId);
              const live = p?.status === "PUBLISHED";
              return (
                <li key={g.fixtureId} className="space-y-2 px-4 py-3 text-sm" data-slot="game-preview-row" data-fixture-id={g.fixtureId}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-text-primary">
                      {g.awayTeamName} @ {g.homeTeamName}
                      {g.competitionName && <span className="font-normal text-text-muted"> · {g.competitionName}</span>}
                    </p>
                    <p className="text-xs text-text-muted">
                      <LocalDateTime iso={g.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                    </p>
                  </div>
                  <p className="text-xs font-medium uppercase tracking-wide text-text-muted" data-slot="preview-status">
                    {live ? (need === "STALE" ? "Preview saved · stale" : "Preview saved") : p?.status === "WITHDRAWN" ? `Withdrawn — ${p.withdrawnReason}` : need === "MISSING" ? "Needs a Preview" : "No Preview yet (not within the lead time)"}
                  </p>
                  <GeneratePreviewForm fixtureId={g.fixtureId} hasPreview={Boolean(live)} />
                  {p && live && (
                    <div className="space-y-2">
                      <p className="font-semibold text-text-primary">{p.hook}</p>
                      <p className="text-text-secondary">{p.body}</p>
                      <p className="text-xs text-text-muted">
                        Written <LocalDateTime iso={p.generatedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> by {p.generatedBy} · last checked{" "}
                        <LocalDateTime iso={p.checkedAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} /> · {p.refreshCount} refresh{p.refreshCount === 1 ? "" : "es"}
                      </p>
                      <details className="text-xs">
                        <summary className="cursor-pointer font-medium text-text-secondary">Sources ({p.sources.length})</summary>
                        <ul className="mt-1 space-y-1" data-slot="preview-sources">
                          {p.sources.map((s, i) => (
                            <li key={i}>
                              <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-accent-primary underline-offset-2 hover:underline">
                                {s.title}
                              </a>{" "}
                              <span className="text-text-muted">
                                — {s.provider}
                                {s.publishedAt && <>, published {new Date(s.publishedAt).toUTCString()}</>}, retrieved {new Date(s.retrievedAt).toUTCString()}
                                {s.supports && <> · supports: {s.supports}</>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                      {p.claims.length > 0 && (
                        <details className="text-xs">
                          <summary className="cursor-pointer font-medium text-text-secondary">Claims and what supports them ({p.claims.length})</summary>
                          <ul className="mt-1 space-y-1" data-slot="preview-claims">
                            {p.claims.map((c, i) => (
                              <li key={i}>
                                {c.text} <span className="text-text-muted">— {(((c as { source_urls?: string[] }).source_urls) ?? c.fact_ids).join(", ")}</span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                      <EditPreviewForm fixtureId={g.fixtureId} hook={p.hook} body={p.body} maxHook={config.hookMaxChars} maxBody={config.maxChars} />
                      <WithdrawPreviewForm fixtureId={g.fixtureId} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
