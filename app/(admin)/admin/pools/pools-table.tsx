"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import {
  bulkArchivePoolsAction,
  bulkDeletePoolsAction,
  bulkUnarchivePoolsAction,
} from "@/lib/actions/pool-lifecycle";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCents, formatBps } from "@/lib/utils/money";
import { humanizeEnum } from "@/lib/utils/humanize";
import { cn } from "@/lib/utils";

// Bulk cleanup only ever targets pools that have fully resolved — matches
// deletePoolAction/delete_terminal_pool's own guard exactly. A pool that's
// still mid-lifecycle needs Cancel Pool first, not a blanket cleanup sweep.
const BULK_DELETABLE_STATUSES = new Set(["SETTLED", "CANCELLED", "VOIDED"]);

export interface PoolOptionRow {
  id: string;
  label: string;
  voteCount: number | null;
  votePercentage: number | null;
}

export interface PoolEntryRow {
  id: string;
  userName: string;
  optionLabel: string;
  amountCents: number;
  status: string;
}

export interface PoolSettlementRow {
  gradingVersion: number;
  outcome: string;
  winnerLabel: string | null;
  confirmedAt: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface PoolRow {
  id: string;
  question: string;
  status: string;
  archivedAt: string | null;
  locks_at: string;
  entryFeeCents: number;
  houseFeeBps: number;
  homeTeamName: string | null;
  awayTeamName: string | null;
  competitionName: string | null;
  kickoffAt: string | null;
  options: PoolOptionRow[];
  entries: PoolEntryRow[];
  settlements: PoolSettlementRow[];
}

const STATUS_OPTIONS = [
  "DRAFT",
  // SCHEDULED is reserved in the pool_status enum but no pool ever actually
  // has it — publish goes straight DRAFT -> OPEN — so it's deliberately
  // left out of this filter list.
  "OPEN",
  "LOCKED",
  "AWAITING_RESULT",
  "READY_FOR_REVIEW",
  "SETTLED",
  "VOIDED",
  "CANCELLED",
  "SETTLEMENT_REVERSED",
  "REVERSAL_FAILED_MANUAL_REVIEW",
] as const;

// Read-only preview of the same information the full /admin/pools/[id]
// "manage" page shows — pool ID, match, options/tallies, entries,
// settlement history. Nothing here is editable: every action control
// (force lock, void, settlement review, reversal, etc.) only exists on
// that page, reached via the Manage link below.
function PoolDetailPanel({ pool }: { pool: PoolRow }) {
  return (
    <div className="space-y-4 px-4 py-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Pool ID</p>
          <p className="font-mono text-xs text-text-secondary">{pool.id}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Match</p>
          {pool.homeTeamName && pool.awayTeamName ? (
            <p className="text-sm text-text-primary">
              {pool.homeTeamName} vs {pool.awayTeamName}
              <span className="block text-xs text-text-muted">
                {pool.competitionName ?? "Unknown competition"}
                {pool.kickoffAt ? ` · ${new Date(pool.kickoffAt).toLocaleString()}` : ""}
              </span>
            </p>
          ) : (
            <p className="text-sm text-text-muted">No linked fixture.</p>
          )}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Question</p>
        <p className="text-sm text-text-primary">{pool.question}</p>
        <p className="text-xs text-text-muted">
          Entry {formatCents(pool.entryFeeCents)} · Coordinator Fee {formatBps(pool.houseFeeBps)}
        </p>
      </div>

      {pool.options.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Options</p>
          <ul className="space-y-1">
            {pool.options.map((option) => (
              <li
                key={option.id}
                className="flex items-center justify-between rounded-lg border border-border-subtle px-3 py-1.5 text-sm"
              >
                <span className="text-text-primary">{option.label}</span>
                <span className="text-text-secondary">
                  {option.votePercentage != null ? `${option.votePercentage}%` : "—"}
                  {option.voteCount != null ? ` (${option.voteCount})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pool.settlements.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">
            Settlement history
          </p>
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
                {pool.settlements.map((s) => (
                  <tr key={s.gradingVersion}>
                    <td className="px-3 py-2 text-text-primary">{s.gradingVersion}</td>
                    <td className="px-3 py-2 text-text-secondary">{humanizeEnum(s.outcome)}</td>
                    <td className="px-3 py-2 text-text-secondary">{s.winnerLabel ?? "—"}</td>
                    <td className="px-3 py-2 text-text-secondary">
                      {s.confirmedAt ? new Date(s.confirmedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      {s.reversedAt ? `${new Date(s.reversedAt).toLocaleString()} — ${s.reversalReason}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">
          Entries ({pool.entries.length})
        </p>
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full text-sm">
            <thead className="bg-surface-secondary text-left text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Player</th>
                <th className="px-3 py-2 font-medium">Choice</th>
                <th className="px-3 py-2 font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {pool.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="px-3 py-2 text-text-primary">{entry.userName}</td>
                  <td className="px-3 py-2 text-text-secondary">{entry.optionLabel}</td>
                  <td className="px-3 py-2 font-medium text-debit">{formatCents(entry.amountCents)}</td>
                  <td className="px-3 py-2 text-text-secondary">{humanizeEnum(entry.status)}</td>
                </tr>
              ))}
              {pool.entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-text-muted">
                    No entries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end">
        <Link href={`/admin/pools/${pool.id}`}>
          <Button size="sm">Manage</Button>
        </Link>
      </div>
    </div>
  );
}

export function PoolsTable({ pools, isSuperAdmin }: { pools: PoolRow[]; isSuperAdmin: boolean }) {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("");
  const [locksDate, setLocksDate] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [archivedOverrides, setArchivedOverrides] = useState<Map<string, string | null>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const archivedAt = (pool: PoolRow) =>
    archivedOverrides.has(pool.id) ? archivedOverrides.get(pool.id)! : pool.archivedAt;

  const filtered = useMemo(() => {
    return pools
      .filter((pool) => !removed.has(pool.id))
      .filter((pool) => {
        if (question && !pool.question.toLowerCase().includes(question.toLowerCase())) return false;
        if (status && pool.status !== status) return false;
        if (locksDate) {
          const poolDate = new Date(pool.locks_at).toISOString().slice(0, 10);
          if (poolDate !== locksDate) return false;
        }
        if (!showArchived && archivedAt(pool)) return false;
        return true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- archivedAt reads archivedOverrides, listed separately
  }, [pools, removed, question, status, locksDate, showArchived, archivedOverrides]);

  const deletableVisible = filtered.filter((p) => BULK_DELETABLE_STATUSES.has(p.status));
  const allDeletableSelected =
    deletableVisible.length > 0 && deletableVisible.every((p) => selected.has(p.id));

  const selectedEligible = deletableVisible.filter((p) => selected.has(p.id));
  const selectedAllArchivable = selectedEligible.length > 0 && selectedEligible.every((p) => !archivedAt(p));
  const selectedAllUnarchivable = selectedEligible.length > 0 && selectedEligible.every((p) => archivedAt(p));

  function toggleSelect(poolId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(poolId)) next.delete(poolId);
      else next.add(poolId);
      return next;
    });
  }

  function toggleSelectAllDeletable() {
    setSelected(allDeletableSelected ? new Set() : new Set(deletableVisible.map((p) => p.id)));
  }

  function handleBulkDelete() {
    setBulkError(null);
    const ids = [...selected];
    startTransition(async () => {
      const result = await bulkDeletePoolsAction(ids);
      if (!result.success) {
        setBulkError(result.error);
        setConfirmingBulkDelete(false);
        return;
      }
      const deletedIds = ids.filter((id) => !result.skippedIds.includes(id));
      setRemoved((prev) => new Set([...prev, ...deletedIds]));
      setSelected(new Set());
      setConfirmingBulkDelete(false);
      if (result.skippedIds.length > 0) {
        setBulkError(
          `${result.deletedCount} pool${result.deletedCount === 1 ? "" : "s"} deleted, ${result.skippedIds.length} skipped (no longer eligible).`,
        );
      }
    });
  }

  function handleBulkArchive() {
    setBulkError(null);
    const ids = selectedEligible.filter((p) => !archivedAt(p)).map((p) => p.id);
    startTransition(async () => {
      const result = await bulkArchivePoolsAction(ids);
      if (!result.success) {
        setBulkError(result.error);
        return;
      }
      const archivedIds = ids.filter((id) => !result.skippedIds.includes(id));
      const now = new Date().toISOString();
      setArchivedOverrides((prev) => {
        const next = new Map(prev);
        for (const id of archivedIds) next.set(id, now);
        return next;
      });
      setSelected(new Set());
      if (result.skippedIds.length > 0) {
        setBulkError(
          `${result.archivedCount} pool${result.archivedCount === 1 ? "" : "s"} archived, ${result.skippedIds.length} skipped (no longer eligible).`,
        );
      }
    });
  }

  function handleBulkUnarchive() {
    setBulkError(null);
    const ids = selectedEligible.filter((p) => archivedAt(p)).map((p) => p.id);
    startTransition(async () => {
      const result = await bulkUnarchivePoolsAction(ids);
      if (!result.success) {
        setBulkError(result.error);
        return;
      }
      const unarchivedIds = ids.filter((id) => !result.skippedIds.includes(id));
      setArchivedOverrides((prev) => {
        const next = new Map(prev);
        for (const id of unarchivedIds) next.set(id, null);
        return next;
      });
      setSelected(new Set());
      if (result.skippedIds.length > 0) {
        setBulkError(
          `${result.unarchivedCount} pool${result.unarchivedCount === 1 ? "" : "s"} unarchived, ${result.skippedIds.length} skipped (no longer eligible).`,
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="filter-question">Question</Label>
          <Input
            id="filter-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Search question"
            className="w-56"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-status">Status</Label>
          <select
            id="filter-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-locks-date">Locks on</Label>
          <Input
            id="filter-locks-date"
            type="date"
            value={locksDate}
            onChange={(e) => setLocksDate(e.target.value)}
            className="w-40"
          />
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-text-secondary">
          <Checkbox checked={showArchived} onCheckedChange={(v) => setShowArchived(!!v)} />
          Show archived
        </label>
        {(question || status || locksDate) && (
          <button
            type="button"
            onClick={() => {
              setQuestion("");
              setStatus("");
              setLocksDate("");
            }}
            className="text-sm text-accent-primary underline underline-offset-4"
          >
            Clear filters
          </button>
        )}
      </div>

      {isSuperAdmin && deletableVisible.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface-secondary px-4 py-2.5">
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <Checkbox checked={allDeletableSelected} onCheckedChange={toggleSelectAllDeletable} />
            Select all settled/voided/cancelled ({deletableVisible.length})
          </label>
          <div className="flex items-center gap-2">
            {confirmingBulkDelete ? (
              <>
                <span className="text-sm text-text-secondary">
                  Permanently delete {selected.size} pool{selected.size === 1 ? "" : "s"}?
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={isPending}
                  onClick={handleBulkDelete}
                >
                  {isPending ? "Deleting…" : "Confirm delete"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingBulkDelete(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                {selectedAllUnarchivable ? (
                  <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleBulkUnarchive}>
                    {isPending ? "Unarchiving…" : `Unarchive selected (${selectedEligible.length})`}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isPending || !selectedAllArchivable}
                    onClick={handleBulkArchive}
                  >
                    {isPending ? "Archiving…" : `Archive selected (${selectedEligible.length})`}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={() => setConfirmingBulkDelete(true)}
                >
                  Delete selected ({selected.size})
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {bulkError && <p className="text-sm text-danger">{bulkError}</p>}

      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              {isSuperAdmin && <th className="w-8 px-3 py-2"></th>}
              <th className="w-8 px-3 py-2"></th>
              <th className="px-3 py-2 font-medium">Question</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Locks</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {filtered.map((pool) => {
              const isExpanded = expandedId === pool.id;
              const isBulkDeletable = BULK_DELETABLE_STATUSES.has(pool.status);
              return (
                <Fragment key={pool.id}>
                  <tr>
                    {isSuperAdmin && (
                      <td className="px-3 py-2">
                        {isBulkDeletable && (
                          <Checkbox
                            checked={selected.has(pool.id)}
                            onCheckedChange={() => toggleSelect(pool.id)}
                            aria-label={`Select ${pool.question}`}
                          />
                        )}
                      </td>
                    )}
                    <td className="p-0" colSpan={4}>
                      <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : pool.id)}
                        aria-expanded={isExpanded}
                        className="grid w-full grid-cols-[2rem_1fr_1fr_1fr] items-center text-left hover:bg-surface-secondary/50"
                      >
                        <span className="flex justify-center px-3 py-2">
                          <ChevronDown
                            aria-hidden="true"
                            className={cn(
                              "size-4 text-text-muted transition-transform",
                              isExpanded && "rotate-180",
                            )}
                          />
                        </span>
                        <span className="px-3 py-2 text-text-primary">{pool.question}</span>
                        <span className="px-3 py-2 text-text-secondary">
                          {humanizeEnum(pool.status)}
                          {archivedAt(pool) && " · Archived"}
                        </span>
                        <span className="px-3 py-2 text-text-secondary">
                          {new Date(pool.locks_at).toLocaleString()}
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/admin/pools/${pool.id}`}
                        className="text-sm text-accent-primary underline underline-offset-4"
                      >
                        Manage
                      </Link>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td
                        colSpan={isSuperAdmin ? 6 : 5}
                        className="border-t border-border-subtle bg-surface-secondary/30 p-0"
                      >
                        <PoolDetailPanel pool={pool} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={isSuperAdmin ? 6 : 5} className="px-3 py-8 text-center text-text-muted">
                  {pools.length === 0 ? "No pools yet." : "No pools match these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
