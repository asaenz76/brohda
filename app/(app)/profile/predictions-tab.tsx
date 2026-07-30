import { ListChecks } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPoolCardViewModels } from "@/lib/pools/fetch";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import type { CardState } from "@/lib/pools/card-state";
import { SocialPoolCard } from "@/components/pools/SocialPoolCard";
import { EmptyFeedState } from "@/components/EmptyFeedState";

// A pick moves here the moment it's made — Feed excludes any pool the
// user has already entered, so OPEN_POST_VOTE (entered, still open) shows
// up in "In progress" right away rather than waiting for the pool to
// lock. POSTPONED_NOTICE/SUSPENDED_NOTICE mean "provider reported an
// anomaly, outcome still pending", so they count as in progress too;
// CANCELLED_NOTICE and VOIDED are always terminal. OPEN_PRE_VOTE can't
// actually occur for an ACTIVE/WON/LOST row (implies hasActiveEntry), but
// a VOID/REFUNDED entry on a pool that's still OPEN has no active entry —
// deriveCardState would read that as OPEN_PRE_VOTE, which is excluded here
// since a voided pick on a still-open pool isn't a meaningful state to show.
const HISTORY_STATES: ReadonlySet<CardState> = new Set([
  "SETTLED_WON",
  "SETTLED_LOST",
  "VOIDED",
  "CANCELLED_NOTICE",
]);
const EXCLUDED_STATES: ReadonlySet<CardState> = new Set(["OPEN_PRE_VOTE"]);

// A defensive cap, not real pagination — every entry ever made used to be
// fetched unbounded, feeding directly into getPoolCardViewModels's
// per-pool cost.
const PREDICTIONS_PAGE_SIZE = 50;

// Factored out of the old standalone /my-picks page so the Profile page's
// "Predictions" tab (Phase 3) can render it for the current user, and the
// public /profile/[username] page (Phase 4) can reuse it scoped to
// `statuses: ["WON", "LOST"]` only — a visited profile shows settled
// picks, never in-flight ACTIVE entries (participation_visibility already
// protects this at the pool level; this avoids undermining that via the
// profile view).
export async function PredictionsTab({
  userId,
  // get_pick_count (the header's "picks" stat) counts every entry
  // regardless of status — VOID/REFUNDED included, since a voided pick
  // still happened. Defaulting to the same full set here keeps the two
  // numbers in agreement; VOID/REFUNDED entries render under History via
  // HISTORY_STATES' existing VOIDED/CANCELLED_NOTICE branches.
  statuses = ["ACTIVE", "WON", "LOST", "VOID", "REFUNDED"],
  viewer,
}: {
  userId: string;
  statuses?: Array<"ACTIVE" | "WON" | "LOST" | "VOID" | "REFUNDED">;
  viewer: { id: string; isModerator: boolean };
}) {
  const supabase = await createClient();

  // entries' RLS only allows reading your own rows — fine for the caller's
  // own profile (userId === viewer.id), but this component is also reused
  // for a *visited* profile, where the request-scoped client would come
  // back empty for someone else's rows even when they're WON/LOST. This
  // component is what enforces "only settled picks are visible on a
  // visited profile" (via the `statuses` param), not RLS, so it's safe to
  // read through the admin client here — same reasoning as every other
  // "this code path already decided what's safe to show" admin-client read
  // elsewhere in this codebase.
  const adminClient = createAdminClient();

  const [{ data: entries }, { data: wallet }, paymentMethods] = await Promise.all([
    adminClient
      .from("entries")
      .select("pool_id")
      .eq("user_id", userId)
      .in("status", statuses)
      .order("created_at", { ascending: false })
      .limit(PREDICTIONS_PAGE_SIZE),
    supabase.from("wallet_balances").select("balance").eq("user_id", userId).single(),
    getPaymentMethods(),
  ]);
  const enabledPaymentMethods = paymentMethods.filter((m) => m.enabled);

  const poolIds = [...new Set((entries ?? []).map((e) => e.pool_id))];
  const viewModels = await getPoolCardViewModels(poolIds, userId, viewer.id);

  // getPoolCardViewModels doesn't guarantee input order — resort to match
  // the entries query's reverse-chronological order.
  const orderedViewModels = poolIds
    .map((id) => viewModels.find((vm) => vm.poolId === id))
    .filter((vm) => vm != null)
    .filter((vm) => !EXCLUDED_STATES.has(vm.status));

  const balanceCents = wallet?.balance ?? 0;

  if (orderedViewModels.length === 0) {
    return (
      <EmptyFeedState
        icon={ListChecks}
        title="No picks yet"
        description="Once you make a pick, it'll show up here — in progress until it settles, then in your history."
      />
    );
  }

  const inProgressViewModels = orderedViewModels.filter((vm) => !HISTORY_STATES.has(vm.status));
  const historyViewModels = orderedViewModels.filter((vm) => HISTORY_STATES.has(vm.status));

  return (
    <div className="space-y-6">
      {inProgressViewModels.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">In progress</h2>
          {inProgressViewModels.map((vm) => (
            <SocialPoolCard
              key={vm.poolId}
              viewModel={vm}
              balanceCents={balanceCents}
              paymentMethods={enabledPaymentMethods}
              viewer={viewer}
              collapsible
            />
          ))}
        </section>
      )}

      {historyViewModels.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">History</h2>
          {historyViewModels.map((vm) => (
            <SocialPoolCard
              key={vm.poolId}
              viewModel={vm}
              balanceCents={balanceCents}
              paymentMethods={enabledPaymentMethods}
              viewer={viewer}
              collapsible
            />
          ))}
        </section>
      )}
    </div>
  );
}
