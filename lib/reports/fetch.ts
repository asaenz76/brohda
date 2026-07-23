import "server-only";
import { createClient } from "@/lib/supabase/server";

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

/** READY_FOR_REVIEW (awaiting a settlement decision) and
 * REVERSAL_FAILED_MANUAL_REVIEW (a blocked reversal) both need admin
 * attention right now — spec's "pending reviews" dashboard section. */
export async function getPendingReviewPools(): Promise<PendingReviewPool[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("pools")
    .select("id, question, status")
    .in("status", ["READY_FOR_REVIEW", "REVERSAL_FAILED_MANUAL_REVIEW"])
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

export interface JobRunSummary {
  jobName: string;
  status: string;
  finishedAt: string;
  durationMs: number;
  error: string | null;
}

export interface JobHealth {
  lastRunByJob: JobRunSummary[];
  recentRuns: JobRunSummary[];
}

const KNOWN_JOBS = ["sync-fixtures", "lock-pools", "process-results"] as const;

export async function getJobHealth(): Promise<JobHealth> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("background_jobs")
    .select("job_name, status, finished_at, duration_ms, error")
    .order("finished_at", { ascending: false })
    .limit(50);

  const rows = (data ?? []).map((r) => ({
    jobName: r.job_name,
    status: r.status,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    error: r.error,
  }));

  const lastRunByJob = KNOWN_JOBS.map(
    (jobName) => rows.find((r) => r.jobName === jobName) ?? {
      jobName,
      status: "never_run",
      finishedAt: "",
      durationMs: 0,
      error: null,
    },
  );

  return { lastRunByJob, recentRuns: rows.slice(0, 20) };
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
