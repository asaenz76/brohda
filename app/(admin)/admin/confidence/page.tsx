import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { LocalDateTime } from "@/components/LocalDateTime";
import { AdjustConfidenceForm, ReverseEntryButton } from "@/components/confidence/AdminConfidenceTools";
import { describeEntry, describeEntryChange, formatConfidence, formatSignedConfidence } from "@/lib/confidence/format";

export const dynamic = "force-dynamic";

// Super Admin only. The economy at a glance (aggregates, never a Member's private history unless you look one Member up on purpose) and one Member's account with its full ledger, where an adjustment or a
// reversal is recorded as a new ledger entry. Deliberately small: no bulk edits, no balance overwrite, no per-Member claim amounts.
interface Overview {
  accounts: number;
  totalConfidence: number;
  available: number;
  reserved: number;
  average: number | null;
  median: number | null;
  distribution: Record<string, number | null>;
  belowBaseline: number;
  atBaseline: number;
  aboveBaseline: number;
  baseline: number;
  eligibleMembers: number;
  initialGrants: { count: number; total: number };
  dailyClaims: { count: number; total: number };
  adminAdjustments: { count: number; net: number };
  reversals: { count: number; net: number };
  predictions: {
    activeBackedPicks: number;
    reserved: number;
    totalCommitted: number;
    backedPicks: number;
    averageCommitted: number | null;
    winningsIssued: number;
    lossesBurned: number;
    voidReleases: number;
    byAmount: Record<string, number>;
  };
  netChange: { days7: number; days30: number };
  reconciliationMismatches: number;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export default async function AdminConfidencePage({ searchParams }: { searchParams: Promise<{ member?: string }> }) {
  await requireSuperAdmin();
  const { member } = await searchParams;
  const admin = createAdminClient();
  const { data } = await admin.rpc("confidence_economy_overview");
  const o = data as Overview | null;

  let lookup: { id: string; displayName: string; username: string | null; available: number | null; reserved: number; entries: Array<Record<string, any>> } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  let lookupMissing = false;
  if (member?.trim()) {
    const { data: profile } = await admin.from("user_profiles").select("id, display_name, username").eq("username", member.trim().toLowerCase()).maybeSingle();
    if (!profile) lookupMissing = true;
    else {
      const [{ data: account }, { data: entries }] = await Promise.all([
        admin.from("confidence_accounts").select("available, reserved").eq("member_id", profile.id).maybeSingle(),
        admin.from("confidence_ledger_entries").select("id, entry_type, available_delta, reserved_delta, available_after, reason_code, note, reverses_entry_id, stake_id, created_at").eq("member_id", profile.id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100),
      ]);
      lookup = { id: profile.id, displayName: profile.display_name, username: profile.username, available: account ? Number(account.available) : null, reserved: account ? Number(account.reserved) : 0, entries: entries ?? [] };
    }
  }
  const reversedIds = new Set((lookup?.entries ?? []).filter((e) => e.reverses_entry_id).map((e) => e.reverses_entry_id as string));

  return (
    <div className="space-y-4" data-slot="admin-confidence">
      <h1 className="text-lg font-semibold text-text-primary">Confidence</h1>
      {!o ? (
        <p role="alert" className="text-sm text-warning-muted">The economy figures couldn&apos;t be read.</p>
      ) : (
        <section aria-label="Economy" data-slot="economy" className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
          <h2 className="text-sm font-semibold text-text-primary">Economy</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {[
              ["Accounts", `${fmt(o.accounts)} of ${fmt(o.eligibleMembers)} eligible Members`],
              ["Total Confidence", formatConfidence(o.totalConfidence)],
              ["Available", formatConfidence(o.available)],
              ["Reserved", formatConfidence(o.reserved)],
              ["Average", fmt(o.average)],
              ["Median", fmt(o.median)],
              ["Below baseline (" + fmt(o.baseline) + ")", fmt(o.belowBaseline)],
              ["At baseline", fmt(o.atBaseline)],
              ["Above baseline", fmt(o.aboveBaseline)],
              ["Initial grants", `${fmt(o.initialGrants.count)} · ${formatConfidence(o.initialGrants.total)}`],
              ["Daily Claims", `${fmt(o.dailyClaims.count)} · ${formatConfidence(o.dailyClaims.total)}`],
              ["Adjustments", `${fmt(o.adminAdjustments.count)} · net ${formatSignedConfidence(o.adminAdjustments.net)}`],
              ["Reversals", `${fmt(o.reversals.count)} · net ${formatSignedConfidence(o.reversals.net)}`],
              ["Net change, 7 days", formatSignedConfidence(o.netChange.days7)],
              ["Net change, 30 days", formatSignedConfidence(o.netChange.days30)],
              ["Ledger mismatches", fmt(o.reconciliationMismatches)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-text-muted">{k}</dt>
                <dd className="font-medium text-text-primary">{v}</dd>
              </div>
            ))}
          </dl>
          <h3 className="pt-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Confidence behind picks</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3" data-slot="backed-picks">
            {[
              ["Active backed picks", fmt(o.predictions.activeBackedPicks)],
              ["Reserved now", formatConfidence(o.predictions.reserved)],
              ["Backed picks, all time", fmt(o.predictions.backedPicks)],
              ["Committed, all time", formatConfidence(o.predictions.totalCommitted)],
              ["Average committed", fmt(o.predictions.averageCommitted)],
              ["Winnings issued", formatConfidence(o.predictions.winningsIssued)],
              ["Losses burned", formatConfidence(o.predictions.lossesBurned)],
              ["Returned on void", formatConfidence(o.predictions.voidReleases)],
              ["By amount", Object.entries(o.predictions.byAmount).map(([a, n]) => `🔥${a} × ${n}`).join(" · ") || "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-text-muted">{k}</dt>
                <dd className="font-medium text-text-primary">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-text-muted">
            Distribution: min {fmt(o.distribution.min)} · 10th {fmt(o.distribution.p10)} · 25th {fmt(o.distribution.p25)} · median {fmt(o.distribution.p50)} · 75th {fmt(o.distribution.p75)} · 90th {fmt(o.distribution.p90)} · max {fmt(o.distribution.max)}
          </p>
        </section>
      )}

      <section aria-label="Member lookup" className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
        <h2 className="text-sm font-semibold text-text-primary">Look up a Member</h2>
        <form method="get" className="flex gap-2">
          <input name="member" defaultValue={member ?? ""} placeholder="username" aria-label="Username" className="h-9 flex-1 rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary" />
          <button type="submit" className="h-9 rounded-md border border-border-subtle px-3 text-sm font-medium text-text-primary">
            Look up
          </button>
        </form>
        {lookupMissing && <p className="text-xs text-text-muted">No Member has that username.</p>}
        {lookup && (
          <div className="space-y-3" data-slot="member-confidence">
            <p className="text-text-primary">
              <span className="font-semibold">{lookup.displayName}</span> {lookup.username ? `(@${lookup.username})` : ""} ·{" "}
              {lookup.available === null ? "no Confidence account yet" : <span data-slot="member-available">{formatConfidence(lookup.available)}</span>}
              {lookup.available !== null && lookup.reserved > 0 ? <span className="text-text-muted" data-slot="member-reserved"> · {formatConfidence(lookup.reserved)} reserved behind picks</span> : null}
            </p>
            {lookup.available !== null && <AdjustConfidenceForm memberId={lookup.id} />}
            <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle" data-slot="member-ledger">
              {lookup.entries.map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 px-3 py-2 text-xs" data-slot="ledger-entry" data-type={e.entry_type}>
                  <div className="space-y-0.5">
                    <p className="font-medium text-text-primary">
                      {describeEntry(e.entry_type)}
                      {e.reason_code ? ` · ${String(e.reason_code).toLowerCase().replace("_", " ")}` : ""}
                      {reversedIds.has(e.id) ? " · reversed" : ""}
                    </p>
                    {e.note && <p className="text-text-secondary">{e.note}</p>}
                    <p className="text-text-muted">
                      <LocalDateTime iso={e.created_at} options={{ month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }} />
                    </p>
                    {e.entry_type !== "REVERSAL" && !e.stake_id && !reversedIds.has(e.id) && <ReverseEntryButton entryId={e.id} />}
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-text-primary">{describeEntryChange(e.entry_type, Number(e.available_delta), Number(e.reserved_delta)).headline}</p>
                    <p className="text-text-muted">{formatConfidence(Number(e.available_after))}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
