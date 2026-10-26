import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { isUuid } from "@/lib/messaging/share";
import { ReviewActions, WithdrawForm } from "@/components/game-stories/AdminGameStoryTools";
import { loadRunDetail } from "@/lib/game-stories/repository";

export const dynamic = "force-dynamic";

// One run in full: the candidate, its score by dimension, every atomic claim with its verdict and the evidence that supports it, all evidence collected (including what was excluded and why), and the model and prompt versions.
const DIMS: Array<[string, string, number]> = [["dim_relevance", "Relevance to the matchup", 30], ["dim_evidence", "Strength of verified evidence", 25], ["dim_debate", "Debate potential", 20], ["dim_originality", "Originality and specificity", 15], ["dim_freshness", "Freshness", 10]];
const badge = (v: string) => (v === "SUPPORTED" || v === "USABLE" ? "text-text-secondary" : "text-danger");

export default async function GameStoryRunPage({ params }: { params: Promise<{ runId: string }> }) {
  await requireAdminOrAbove();
  const { runId } = await params;
  if (!isUuid(runId)) notFound();
  const detail = await loadRunDetail(runId);
  if (!detail) notFound();
  const { run, evidence, claims, links, revisions } = detail;
  const evById = new Map(evidence.map((e) => [e.id, e]));
  const supports = (claimId: string) => links.filter((l) => l.claim_id === claimId).map((l) => evById.get(l.evidence_id)).filter(Boolean);
  const live = revisions.find((r) => r.status === "APPROVED");
  const reviewable = revisions.find((r) => r.status === "REVIEW_REQUIRED");
  const details = (run.details ?? {}) as { candidates?: Array<{ angle: string; code: string | null; total: number | null; caps: string[]; rationale: string | null; hook: string; detail?: string }>; angles?: Array<{ type: string; summary: string; evidence: number; usable: boolean }> };

  return (
    <div className="space-y-6" data-slot="admin-game-story-run">
      <p className="text-sm">
        <Link href="/admin/game-stories" className="underline">
          ← Game Stories
        </Link>
      </p>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-text-primary">
          Run {run.status.toLowerCase().replace("_", " ")}
          {run.decision ? ` — ${run.decision.toLowerCase().replace("_", " ")}` : ""}
        </h1>
        <p className="text-xs text-text-muted">
          {run.trigger_kind.toLowerCase()} · started {new Date(run.started_at).toUTCString()} · {run.model} ({run.effort}) · prompt {run.prompt_version ?? "–"} · {run.model_calls} model calls, {run.search_calls} searches, {Number(run.input_tokens).toLocaleString()} tokens in / {Number(run.output_tokens).toLocaleString()} out ·{" "}
          {run.elapsed_ms ? `${(run.elapsed_ms / 1000).toFixed(1)}s` : "–"}
        </p>
        {run.rejection_code && (
          <p role="status" className="text-sm text-danger" data-slot="rejection">
            Rejected: {run.rejection_code}. {run.rejection_detail}
          </p>
        )}
        {run.error_category && <p className="text-sm text-danger">Failed: {run.error_category}. {run.rejection_detail}</p>}
      </header>

      {run.candidate_hook && (
        <section className="space-y-2" data-slot="candidate">
          <h2 className="text-sm font-semibold text-text-primary">Candidate</h2>
          <p className="text-lg font-semibold leading-snug text-text-primary">{run.candidate_hook}</p>
          <p className="text-[15px] leading-relaxed text-text-secondary">{run.candidate_body}</p>
          <p className="text-xs text-text-muted">{(run.candidate_hook?.length ?? 0) + (run.candidate_body?.length ?? 0)} characters</p>
        </section>
      )}

      {run.total_score != null && (
        <section className="space-y-1" data-slot="score">
          <h2 className="text-sm font-semibold text-text-primary">
            Score {run.total_score}/100 <span className="font-normal text-text-muted">(minimum {run.min_score_applied}; computed by Brohda from the five dimensions)</span>
          </h2>
          <ul className="text-sm text-text-secondary">
            {DIMS.map(([key, label, max]) => (
              <li key={key}>
                {label}: {run[key]}/{max}
              </li>
            ))}
          </ul>
          {details.candidates?.[0]?.caps?.length ? <p className="text-xs text-text-muted">Caps applied: {details.candidates.flatMap((c) => c.caps).join("; ")}</p> : null}
        </section>
      )}

      {claims.length > 0 && (
        <section className="space-y-2" data-slot="claims">
          <h2 className="text-sm font-semibold text-text-primary">Atomic claims ({claims.length})</h2>
          <ul className="space-y-2">
            {claims.map((c) => (
              <li key={c.id} className="rounded-md border border-border-subtle p-2 text-sm">
                <p className="text-text-primary">{c.claim_text}</p>
                <p className={`text-xs ${badge(c.verdict)}`}>
                  {c.claim_type} · {c.verdict}
                  {c.availability_status ? ` · ${c.availability_status}` : ""} · deterministic {c.deterministic_ok ? "ok" : "failed"} · verifier {c.model_verdict ?? "–"}
                  {c.verification_note ? ` · ${c.verification_note}` : ""}
                </p>
                <ul className="mt-1 text-xs text-text-muted">
                  {supports(c.id).map((e) => (
                    <li key={e!.id}>
                      supported by {e!.publisher}
                      {e!.title ? ` — ${e!.title}` : ""} ({e!.source_kind.toLowerCase().replace("_", " ")}, authority {e!.authority}
                      {e!.published_at ? `, ${new Date(e!.published_at).toISOString().slice(0, 10)}` : ""})
                    </li>
                  ))}
                  {supports(c.id).length === 0 && <li>no evidence cited</li>}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2" data-slot="evidence">
        <h2 className="text-sm font-semibold text-text-primary">Evidence ({evidence.length})</h2>
        <ul className="space-y-1 text-xs text-text-secondary">
          {evidence.map((e) => (
            <li key={e.id} className="rounded-md border border-border-subtle p-2">
              <span className={badge(e.status)}>
                {e.status}
                {e.status_reason ? ` (${e.status_reason})` : ""}
              </span>{" "}
              · {e.source_kind.toLowerCase().replace("_", " ")} · authority {e.authority} · {e.publisher}
              {e.url ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={e.url} target="_blank" rel="noopener noreferrer" className="underline">
                    {e.title ?? e.url}
                  </a>
                </>
              ) : null}
              {e.published_at ? ` · published ${new Date(e.published_at).toISOString().slice(0, 16)}Z` : " · no publication date"} · about {e.subject_team.toLowerCase()}
              <br />
              {e.fact_text}
              {e.excerpt ? <em className="block text-text-muted">“{e.excerpt}”</em> : null}
            </li>
          ))}
        </ul>
      </section>

      {details.angles && details.angles.length > 0 && (
        <section className="space-y-1" data-slot="angles">
          <h2 className="text-sm font-semibold text-text-primary">Angles considered</h2>
          <ul className="text-xs text-text-muted">
            {details.angles.map((a, i) => (
              <li key={i}>
                {a.type}: {a.summary} ({a.evidence} sources{a.usable ? "" : ", not drafted"})
              </li>
            ))}
          </ul>
        </section>
      )}

      {reviewable && (
        <section className="space-y-2" data-slot="run-review">
          <h2 className="text-sm font-semibold text-text-primary">Review</h2>
          <ReviewActions revisionId={reviewable.id} requiresVerification={Boolean(reviewable.requires_verification)} />
        </section>
      )}
      {live && (
        <section className="space-y-2" data-slot="run-live">
          <h2 className="text-sm font-semibold text-text-primary">This story is live on the Post</h2>
          <p className="text-xs text-text-muted">Approved {live.approved_at ? new Date(live.approved_at).toUTCString() : ""}. Withdrawing keeps the revision for the record and leaves the Post without a story.</p>
          <WithdrawForm fixtureId={run.fixture_id} />
        </section>
      )}
      {revisions.length > 0 && (
        <section className="space-y-1" data-slot="revisions">
          <h2 className="text-sm font-semibold text-text-primary">Revisions</h2>
          <ul className="text-xs text-text-muted">
            {revisions.map((r) => (
              <li key={r.id}>
                {new Date(r.created_at).toUTCString()} · {r.source.toLowerCase().replace("_", " ")} · {r.status.toLowerCase().replace("_", " ")} · “{r.hook}”
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
