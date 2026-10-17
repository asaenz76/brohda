import { requireSuperAdmin } from "@/lib/auth/session";
import { LocalDateTime } from "@/components/LocalDateTime";
import { GamePreviewConfigForm, WithdrawPreviewForm } from "@/components/game-previews/AdminGamePreviewTools";
import { getGamePreviewConfig, listGamePreviewCandidates, listGamePreviewsForAdmin, listUpcomingGamesForAdmin } from "@/lib/game-previews/repository";

export const dynamic = "force-dynamic";

// Super Admin only. The editorial side of the Game Post: which upcoming Games have a Game Preview, which still need one (missing or stale), what each Preview says and exactly which sources it rests on, and the limits and timings
// (stored configuration, nothing is a constant in code). Previews are researched and written ahead of time and saved; nothing here — or on the Post — researches or generates anything when a page is opened.
const SHOW_DAYS = 14;

export default async function AdminGamePreviewsPage() {
  await requireSuperAdmin();
  const [config, candidates] = await Promise.all([getGamePreviewConfig(), listGamePreviewCandidates()]);
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

      <section className="space-y-3" aria-label="Settings">
        <h2 className="text-sm font-semibold text-text-primary">Limits and timings</h2>
        <GamePreviewConfigForm config={config} />
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
