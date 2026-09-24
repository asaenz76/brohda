import "server-only";
import { createClient } from "@/lib/supabase/server";
import { JOB_REGISTRY } from "@/lib/jobs/registry";
import { computeJobHealth, type BackgroundJobRow, type JobHealthEntry } from "@/lib/jobs/health";
import { getBrohdaSettings } from "@/lib/admin-settings/repository";

export interface UserCounts {
  total: number;
  active: number;
  inactive: number;
}

export async function getUserCounts(): Promise<UserCounts> {
  const supabase = await createClient();
  const { data } = await supabase.from("user_profiles").select("is_active");

  const rows = data ?? [];
  const active = rows.filter((r) => r.is_active).length;

  return { total: rows.length, active, inactive: rows.length - active };
}

export type PoolStatusCounts = Record<string, number>;

export async function getPoolStatusCounts(): Promise<PoolStatusCounts> {
  const supabase = await createClient();
  const { data } = await supabase.from("pools").select("status");

  const counts: PoolStatusCounts = {};
  for (const row of data ?? []) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

export interface PendingReviewPool {
  id: string;
  question: string;
  status: string;
}

/** READY_FOR_REVIEW (awaiting a settlement decision), REVERSAL_FAILED_
 * MANUAL_REVIEW (a blocked reversal), and MANUAL_REVIEW (an integrity
 * issue — unresolvable binary options/template version/config) all need
 * admin attention right now — spec's "pending reviews" dashboard section. */
export async function getPendingReviewPools(): Promise<PendingReviewPool[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("pools")
    .select("id, question, status")
    .in("status", ["READY_FOR_REVIEW", "REVERSAL_FAILED_MANUAL_REVIEW", "MANUAL_REVIEW"])
    .order("created_at", { ascending: false });

  return data ?? [];
}

export interface HouseRevenue {
  currentBalance: number;
  feeCreditTotal: number;
  remainderCreditTotal: number;
  reversalDebitTotal: number;
}

/**
 * "House revenue excluding reversed" needs no special filtering (decision
 * #4): reversal is an explicit compensating debit against the house
 * account tagged with the same settlement, so the house's current balance
 * already nets out anything reversed.
 */
export async function getHouseRevenue(): Promise<HouseRevenue> {
  const supabase = await createClient();

  const [{ data: balanceRow }, { data: transactions }] = await Promise.all([
    supabase.from("wallet_balances").select("balance").eq("account_type", "house").single(),
    supabase.from("wallet_transactions").select("type, amount").eq("account_type", "house"),
  ]);

  let feeCreditTotal = 0;
  let remainderCreditTotal = 0;
  let reversalDebitTotal = 0;

  for (const t of transactions ?? []) {
    if (t.type === "house_fee_credit") feeCreditTotal += t.amount;
    else if (t.type === "rounding_remainder_credit") remainderCreditTotal += t.amount;
    else if (t.type === "settlement_reversal_debit") reversalDebitTotal += t.amount;
  }

  return {
    currentBalance: balanceRow?.balance ?? 0,
    feeCreditTotal,
    remainderCreditTotal,
    reversalDebitTotal,
  };
}

export interface JobHealth {
  jobs: JobHealthEntry[];
}

/**
 * Milestone R13.9 — replaces the old hard-coded 3-job KNOWN_JOBS list
 * (which had already drifted: it named "sync-fixtures", the real
 * job_name is "sync-fixtures-nfl", so that job's health silently read
 * "never run" forever). Now driven entirely by lib/jobs/registry.ts, the
 * same identifiers every cron route actually uses, so a job can never be
 * missing from this dashboard or misspelled relative to it.
 *
 * One shared query across all 10 jobs (rather than one query per job) —
 * a comfortable window (200 rows) easily covers every job's recent
 * history at their fastest expected cadence (1 minute) for 20+ minutes
 * back, which is far more than needed to find each job's latest run and
 * its latest successful run.
 */
export async function getJobHealth(): Promise<JobHealth> {
  const supabase = await createClient();
  const [{ data }, settings] = await Promise.all([
    supabase
      .from("background_jobs")
      .select("job_name, status, result, error, started_at, finished_at, duration_ms")
      .order("finished_at", { ascending: false })
      .limit(200),
    getBrohdaSettings(),
  ]);

  const rows: BackgroundJobRow[] = data ?? [];
  const now = new Date();
  const jobs = JOB_REGISTRY.map((job) =>
    computeJobHealth(job, rows, now, settings.operations.jobStalenessMultiplier),
  );

  return { jobs };
}

export type TransactionTypeTotals = Record<string, { credit: number; debit: number }>;

export async function getTransactionTypeTotals(): Promise<TransactionTypeTotals> {
  const supabase = await createClient();
  const { data } = await supabase.from("wallet_transactions").select("type, direction, amount");

  const totals: TransactionTypeTotals = {};
  for (const t of data ?? []) {
    if (!totals[t.type]) totals[t.type] = { credit: 0, debit: 0 };
    totals[t.type][t.direction as "credit" | "debit"] += t.amount;
  }
  return totals;
}
