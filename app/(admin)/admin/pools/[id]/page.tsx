import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCents, formatBps } from "@/lib/utils/money";
import { humanizeEnum } from "@/lib/utils/humanize";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PublishButton } from "./publish-button";
import { EditPoolForm } from "./edit-pool-form";
import { VoidEntryForm } from "./void-entry-form";
import { SettlementReviewForm } from "./settlement-review-form";
import { AbortReversalButton, ReversalRequestForm } from "./reversal-form";
import { ComboLegGradingForm } from "./combo-leg-grading-form";
import { ComboSettlementReviewForm } from "./combo-settlement-review-form";
import { TemplateSettlementReviewForm } from "./template-settlement-review-form";
import {
  AdvanceLockedPoolButton,
  ArchivePoolButton,
  CancelPoolButton,
  CheckResultButton,
  DeletePoolButton,
  ForceLockButton,
  GradeManuallyButton,
  UndoGradingButton,
} from "./lifecycle-actions";

const CANCELLABLE_STATUSES = ["DRAFT", "OPEN", "LOCKED", "AWAITING_RESULT", "MANUAL_REVIEW"];

export default async function AdminPoolDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();

  const { data: pool } = await supabase.from("pools").select("*").eq("id", id).single();
  if (!pool) notFound();

  const [{ data: options }, { data: entries }, { data: settlements }, { data: comboLegs }] =
    await Promise.all([
      supabase.from("pool_options_public").select("*").eq("pool_id", id).order("sort_order"),
      supabase
        .from("entries")
        .select("*")
        .eq("pool_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("settlements")
        .select("*")
        .eq("pool_id", id)
        .order("grading_version", { ascending: false }),
      pool.pool_type === "COMBO"
        ? supabase.from("pool_combo_legs").select("*").eq("pool_id", id).order("sort_order")
        : Promise.resolve({ data: [] }),
    ]);

  const currentSettlement =
    (settlements ?? []).find((s) => s.grading_version === pool.snapshot_version) ?? null;

  // pool_options_public gates entry_count/total_entry_amount behind the
  // pool's own player-facing participation_visibility — irrelevant here,
  // since the combo settlement preview below needs the real counts
  // regardless of what players are allowed to see. Only fetched for a
  // COMBO pool actually sitting at the review step.
  const comboOptionCounts =
    pool.pool_type === "COMBO" && pool.status === "READY_FOR_REVIEW"
      ? (
          await createAdminClient().from("pool_options").select("id, entry_count").eq("pool_id", id)
        ).data
      : null;

  // Same reasoning as comboOptionCounts — the review preview needs real
  // entry counts regardless of the pool's own participation_visibility.
  const templateOptionCounts =
    pool.pool_type === "TEMPLATE_GRADED" && pool.status === "READY_FOR_REVIEW"
      ? (
          await createAdminClient().from("pool_options").select("id, entry_count").eq("pool_id", id)
        ).data
      : null;

  const templateGradingEvidence =
    pool.pool_type === "TEMPLATE_GRADED" && pool.status === "READY_FOR_REVIEW" && currentSettlement
      ? (
          await createAdminClient()
            .from("pool_grading_evidence")
            .select("reason")
            .eq("settlement_id", currentSettlement.id)
            .order("graded_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        ).data
      : null;

  const shortfallUserIds = (currentSettlement?.reversal_shortfall_report ?? []).map(
    (s: { userId: string }) => s.userId,
  );
  const userIds = [
    ...new Set([...(entries ?? []).map((e) => e.user_id), ...shortfallUserIds]),
  ];
  const { data: users } =
    userIds.length > 0
      ? await supabase.from("user_profiles").select("id, display_name").in("id", userIds)
      : { data: [] };

  const optionLabel = (optionId: string) =>
    (options ?? []).find((o) => o.id === optionId)?.label ?? "—";
  const userName = (userId: string) =>
    (users ?? []).find((u) => u.id === userId)?.display_name ?? "Unknown";

  const hasEntries = !!pool.first_entry_at;
  // Deletable either before any entry ever happened, or once the pool has
  // fully resolved (SETTLED/CANCELLED/VOIDED) — matches
  // deletePoolAction/delete_terminal_pool's own guard exactly. Everything
  // else mid-lifecycle still isn't deletable; Cancel Pool is the only way
  // to unwind those.
  const isDeletable = !hasEntries || ["SETTLED", "CANCELLED", "VOIDED"].includes(pool.status);
  // Archiving only ever applies to a resolved pool with real history worth
  // keeping around (not deleting) but hiding from the default list —
  // matches ARCHIVABLE_STATUSES in lib/actions/pool-lifecycle.ts exactly.
  const isArchivable = ["SETTLED", "CANCELLED", "VOIDED"].includes(pool.status);

  // A COMBO pool graded through its own leg checkboxes always has either a
  // did_not_play leg or a stamped winning_option_id by the time it reaches
  // review (see gradeComboLegsAction) — this is false only if the admin
  // instead used the generic "Grade manually" override, in which case the
  // regular dropdown-driven SettlementReviewForm below is the right escape
  // hatch (same one UndoGradingButton's own doc comment already covers).
  const comboDidNotPlay = (comboLegs ?? []).some((leg) => leg.did_not_play);
  const comboGradedViaLegs =
    pool.pool_type === "COMBO" && (comboDidNotPlay || currentSettlement?.winning_option_id != null);
  const comboWinningEntryCount = currentSettlement?.winning_option_id
    ? ((comboOptionCounts ?? []).find((o) => o.id === currentSettlement.winning_option_id)?.entry_count ?? 0)
    : null;
  const comboTotalEntries = (comboOptionCounts ?? []).reduce((sum, o) => sum + (o.entry_count ?? 0), 0);

  // A TEMPLATE_GRADED pool always has its winner pre-stamped by
  // gradeTemplatePool by the time it reaches review — winning_option_reason
  // distinguishes "the registry graded this" from a plain manual override
  // (e.g. an admin used the generic Grade Manually button instead), which
  // still falls through to the regular dropdown-driven SettlementReviewForm.
  const templateGraded =
    pool.pool_type === "TEMPLATE_GRADED" && currentSettlement?.winning_option_reason === "TEMPLATE_GRADED";
  const templateWinningEntryCount = currentSettlement?.winning_option_id
    ? ((templateOptionCounts ?? []).find((o) => o.id === currentSettlement.winning_option_id)?.entry_count ?? 0)
    : 0;
  const templateTotalEntries = (templateOptionCounts ?? []).reduce((sum, o) => sum + (o.entry_count ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          {pool.title && <p className="text-sm text-text-secondary">{pool.title}</p>}
          <h1 className="text-lg font-semibold text-text-primary">{pool.question}</h1>
          <p className="text-sm text-text-secondary">
            Status: {humanizeEnum(pool.status)}
            {pool.archived_at && " · Archived"} · Entry {formatCents(pool.entry_fee)} · Platform Fee{" "}
            {formatBps(pool.house_fee_bps)}
          </p>
          <p className="text-xs text-text-muted">
            Locks {new Date(pool.locks_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Pre-fills the creation wizard from this pool's template/
              financial config for a new fixture — not a data mutation, so
              no super-admin-only comment needed the way the buttons below
              have; gated on isSuperAdmin only because /admin/pools/new
              itself is (a plain admin would otherwise hit a dead-end
              redirect). CUSTOM pools have no wizard equivalent to land on. */}
          {isSuperAdmin && pool.pool_type !== "CUSTOM" && (
            <Link href={`/admin/pools/new?duplicateFrom=${pool.id}`}>
              <Button variant="outline" size="sm">
                Duplicate
              </Button>
            </Link>
          )}
          {pool.status === "DRAFT" && <PublishButton poolId={pool.id} />}
          {pool.status === "OPEN" && <ForceLockButton poolId={pool.id} />}
          {/* Can auto-refund below minimum entries — money movement, super_admin only. */}
          {pool.status === "LOCKED" && isSuperAdmin && <AdvanceLockedPoolButton poolId={pool.id} />}
          {/* Refunds every active entry outright — money movement, super_admin only. */}
          {CANCELLABLE_STATUSES.includes(pool.status) && isSuperAdmin && (
            <CancelPoolButton poolId={pool.id} />
          )}
          {/* Reversible hide-from-list, once fully resolved, super_admin only. */}
          {isArchivable && isSuperAdmin && (
            <ArchivePoolButton poolId={pool.id} archived={!!pool.archived_at} />
          )}
          {/* Hard delete — before any entry ever happened, or once fully
              resolved (SETTLED/CANCELLED/VOIDED), super_admin only. */}
          {isDeletable && isSuperAdmin && <DeletePoolButton poolId={pool.id} />}
        </div>
      </div>

      {/* An integrity issue with the pool's own data (unresolvable binary
          options/template version/config), not a normal settlement state —
          funds are preserved, no entries were ever refunded or paid out.
          Cancel Pool (above, already gated on CANCELLABLE_STATUSES
          including MANUAL_REVIEW) is the only resolution path today. */}
      {pool.status === "MANUAL_REVIEW" && (
        <Card>
          <CardContent className="space-y-2 pt-6">
            <h2 className="text-sm font-semibold text-text-primary">Needs manual review</h2>
            <p className="text-sm text-text-secondary">
              {pool.review_reason
                ? `Reason: ${humanizeEnum(pool.review_reason)}.`
                : "No reason was recorded."}{" "}
              No money has moved — entries are preserved and the pool won&rsquo;t enter automatic
              settlement. Use Cancel Pool above to refund everyone in full once you&rsquo;ve looked
              into it.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Can auto-void-and-refund on an anomaly — money movement, super_admin only. */}
      {(pool.status === "LOCKED" || pool.status === "AWAITING_RESULT") && isSuperAdmin && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h2 className="text-sm font-semibold text-text-primary">Grade this pool</h2>
            {pool.status === "AWAITING_RESULT" &&
              pool.pool_type !== "CUSTOM" &&
              pool.pool_type !== "COMBO" && (
                <>
                  <p className="text-sm text-text-secondary">
                    Checks the linked fixture right now instead of waiting for the next scheduled
                    pass — voids the pool if the match is postponed/cancelled/etc. past its grace
                    window, moves it to Ready for Review once the fixture reports a final score, or
                    reports that it&rsquo;s still in progress.
                  </p>
                  <CheckResultButton poolId={pool.id} />
                </>
              )}
            {pool.pool_type === "COMBO" && (comboLegs ?? []).length > 0 && (
              <ComboLegGradingForm
                poolId={pool.id}
                legs={(comboLegs ?? []).map((leg) => ({
                  id: leg.id,
                  label: leg.label,
                  isMet: leg.is_met,
                  didNotPlay: leg.did_not_play,
                }))}
              />
            )}
            <p className="text-sm text-text-secondary">
              Skips any automatic check and jumps straight to picking the winner by hand.
            </p>
            <GradeManuallyButton poolId={pool.id} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-4 text-sm font-semibold text-text-primary">Edit pool</h2>
          <EditPoolForm
            poolId={pool.id}
            entryFeeDollars={(pool.entry_fee / 100).toFixed(2)}
            houseFeePercent={formatBps(pool.house_fee_bps).replace("%", "")}
            minTotalEntries={pool.min_total_entries}
            visibility={pool.visibility}
            participationVisibility={pool.participation_visibility}
            locksAtIso={pool.locks_at}
            isTierGrouped={pool.tier_group_id != null}
            hasEntries={hasEntries}
          />
        </CardContent>
      </Card>

      {/* Confirms settlement / pays out winners — money movement, super_admin only. */}
      {pool.status === "READY_FOR_REVIEW" && currentSettlement && isSuperAdmin && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-text-primary">Review result</h2>
              {/* Nothing's been confirmed yet at this point (page only
                  reaches here while status is still READY_FOR_REVIEW) — safe
                  to back out and re-grade instead of committing to whichever
                  path produced this proposal. */}
              <UndoGradingButton poolId={pool.id} />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-muted">Provider status</dt>
              <dd className="text-text-primary">{currentSettlement.provider_status}</dd>
              <dt className="text-text-muted">Regulation score</dt>
              <dd className="text-text-primary">
                {currentSettlement.regulation_home_score ?? "—"} –{" "}
                {currentSettlement.regulation_away_score ?? "—"}
              </dd>
              {(currentSettlement.extra_time_home_score != null ||
                currentSettlement.extra_time_away_score != null) && (
                <>
                  <dt className="text-text-muted">Extra time score</dt>
                  <dd className="text-text-primary">
                    {currentSettlement.extra_time_home_score ?? "—"} –{" "}
                    {currentSettlement.extra_time_away_score ?? "—"}
                  </dd>
                </>
              )}
              {(currentSettlement.penalty_home_score != null ||
                currentSettlement.penalty_away_score != null) && (
                <>
                  <dt className="text-text-muted">Penalties</dt>
                  <dd className="text-text-primary">
                    {currentSettlement.penalty_home_score ?? "—"} –{" "}
                    {currentSettlement.penalty_away_score ?? "—"}
                  </dd>
                </>
              )}
              <dt className="text-text-muted">Proposed winner</dt>
              <dd className="text-text-primary">
                {currentSettlement.winning_option_id
                  ? optionLabel(currentSettlement.winning_option_id)
                  : "Not determined"}
              </dd>
              <dt className="text-text-muted">Gross pool</dt>
              <dd className="text-text-primary">{formatCents(currentSettlement.gross_pool)}</dd>
              <dt className="text-text-muted">Platform fee</dt>
              <dd className="text-text-primary">{formatCents(currentSettlement.house_fee_amount)}</dd>
              <dt className="text-text-muted">Net prize pool</dt>
              <dd className="text-text-primary">{formatCents(currentSettlement.net_prize_pool)}</dd>
              <dt className="text-text-muted">Winning entries</dt>
              <dd className="text-text-primary">{currentSettlement.winning_entry_count ?? "—"}</dd>
              <dt className="text-text-muted">Payout per entry</dt>
              <dd className="text-text-primary">{formatCents(currentSettlement.payout_per_entry)}</dd>
              <dt className="text-text-muted">Rounding retained</dt>
              <dd className="text-text-primary">{formatCents(currentSettlement.rounding_remainder)}</dd>
            </dl>

            {templateGraded && currentSettlement.winning_option_id ? (
              <TemplateSettlementReviewForm
                poolId={pool.id}
                gradingVersion={currentSettlement.grading_version}
                winningOptionLabel={optionLabel(currentSettlement.winning_option_id)}
                gradingReason={templateGradingEvidence?.reason ?? "—"}
                winningEntryCount={templateWinningEntryCount}
                totalEntries={templateTotalEntries}
                grossPool={currentSettlement.gross_pool}
                houseFeeBps={currentSettlement.house_fee_bps}
              />
            ) : comboGradedViaLegs ? (
              <ComboSettlementReviewForm
                poolId={pool.id}
                gradingVersion={currentSettlement.grading_version}
                didNotPlay={comboDidNotPlay}
                winningOptionLabel={
                  currentSettlement.winning_option_id ? optionLabel(currentSettlement.winning_option_id) : null
                }
                winningEntryCount={comboWinningEntryCount}
                totalEntries={comboTotalEntries}
                grossPool={currentSettlement.gross_pool}
                houseFeeBps={currentSettlement.house_fee_bps}
              />
            ) : (
              <SettlementReviewForm
                poolId={pool.id}
                gradingVersion={currentSettlement.grading_version}
                outcome={currentSettlement.outcome}
                requiresManualVerification={currentSettlement.requires_manual_verification}
                options={(options ?? []).map((o) => ({ id: o.id, label: o.label }))}
                gradedWinningOptionLabel={
                  currentSettlement.winning_option_id ? optionLabel(currentSettlement.winning_option_id) : null
                }
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* Debits winners/house back — money movement, super_admin only. */}
      {pool.status === "SETTLED" && isSuperAdmin && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <h2 className="text-sm font-semibold text-text-primary">Settlement reversal</h2>
            <p className="text-sm text-text-secondary">
              Reversing debits every winner and the platform fee back, then returns this pool to
              review with a fresh result snapshot.
            </p>
            <ReversalRequestForm poolId={pool.id} />
          </CardContent>
        </Card>
      )}

      {/* Retry/abort a blocked reversal — money movement, super_admin only. */}
      {pool.status === "REVERSAL_FAILED_MANUAL_REVIEW" && currentSettlement && isSuperAdmin && (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <h2 className="text-sm font-semibold text-text-primary">Reversal blocked</h2>
            <p className="text-sm text-text-secondary">
              At least one winner&rsquo;s balance can&rsquo;t absorb the reversal debit. Resolve the
              shortfall (e.g. an admin adjustment) outside this flow, then retry — or abort to keep
              the pool settled with no financial effect.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border-subtle">
              <table className="w-full text-sm">
                <thead className="bg-surface-secondary text-left text-text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Player</th>
                    <th className="px-3 py-2 font-medium">Credited amount</th>
                    <th className="px-3 py-2 font-medium">Current balance</th>
                    <th className="px-3 py-2 font-medium">Shortfall</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {(currentSettlement.reversal_shortfall_report ?? []).map(
                    (row: {
                      userId: string;
                      creditedAmount: number;
                      currentBalance: number;
                      shortfall: number;
                    }) => (
                      <tr key={row.userId}>
                        <td className="px-3 py-2 text-text-primary">{userName(row.userId)}</td>
                        <td className="px-3 py-2 font-medium text-credit">
                          {formatCents(row.creditedAmount)}
                        </td>
                        <td className="px-3 py-2 text-text-secondary">
                          {formatCents(row.currentBalance)}
                        </td>
                        <td
                          className={
                            row.shortfall > 0 ? "px-3 py-2 font-medium text-danger" : "px-3 py-2 text-text-secondary"
                          }
                        >
                          {formatCents(row.shortfall)}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ReversalRequestForm
                poolId={pool.id}
                defaultReason={currentSettlement.reversal_reason ?? ""}
                submitLabel="Retry Reversal"
              />
              <AbortReversalButton poolId={pool.id} />
            </div>
          </CardContent>
        </Card>
      )}

      {(settlements ?? []).length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="px-3 py-2 font-medium">Winner</th>
                <th className="px-3 py-2 font-medium">Confirmed</th>
                <th className="px-3 py-2 font-medium">Reversed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {(settlements ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 text-text-primary">{s.grading_version}</td>
                  <td className="px-3 py-2 text-text-secondary">{humanizeEnum(s.outcome)}</td>
                  <td className="px-3 py-2 text-text-secondary">
                    {s.winning_option_id ? optionLabel(s.winning_option_id) : "—"}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">
                    {s.confirmed_at ? new Date(s.confirmed_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-text-secondary">
                    {s.reversed_at
                      ? `${new Date(s.reversed_at).toLocaleString()} — ${s.reversal_reason}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Player</th>
              <th className="px-3 py-2 font-medium">Choice</th>
              <th className="px-3 py-2 font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {(entries ?? []).map((entry) => (
              <tr key={entry.id}>
                <td className="px-3 py-2 text-text-primary">{userName(entry.user_id)}</td>
                <td className="px-3 py-2 text-text-secondary">{optionLabel(entry.option_id)}</td>
                <td className="px-3 py-2 font-medium text-debit">{formatCents(entry.amount)}</td>
                <td className="px-3 py-2 text-text-secondary">{humanizeEnum(entry.status)}</td>
                <td className="px-3 py-2 text-right">
                  {/* Refunds the voided entry — money movement, super_admin only. */}
                  {entry.status === "ACTIVE" && pool.status === "OPEN" && isSuperAdmin && (
                    <VoidEntryForm key={entry.id} entryId={entry.id} />
                  )}
                </td>
              </tr>
            ))}
            {(!entries || entries.length === 0) && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-text-muted">
                  No entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
