"use client";

import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import type { LandingLeaderboardEntry, LandingSampleAnalytics } from "@/lib/landing/fetch";
import { formatCents } from "@/lib/utils/money";
import { formatPickRecord } from "@/components/leaderboard/Podium";
import { Podium } from "@/components/leaderboard/Podium";
import { RankedList } from "@/components/leaderboard/RankedList";
import { LineChartCard } from "@/components/analytics/LineChartCard";
import { MetricCard } from "@/components/analytics/MetricCard";
import { PhoneFrame } from "./PhoneFrame";
import { PoolPreviewCard } from "./PoolPreviewCard";

const NIL_USER_ID = "00000000-0000-0000-0000-000000000000";

function ShowcasePanel({
  index,
  title,
  description,
  children,
}: {
  index: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-6 items-center justify-center rounded-full bg-accent-primary/20 text-accent-primary-label">
          {index}
        </span>
        {title}
      </div>
      <p className="text-sm text-inverted-surface-foreground/70">{description}</p>
      <PhoneFrame>{children}</PhoneFrame>
    </div>
  );
}

export function ProductShowcase({
  feedPools,
  leaderboard,
  sampleAnalytics,
}: {
  feedPools: SocialPoolCardViewModel[];
  leaderboard: LandingLeaderboardEntry[];
  sampleAnalytics: LandingSampleAnalytics | null;
}) {
  const hasFeed = feedPools.length > 0;
  const hasLeaderboard = leaderboard.length > 0;
  const hasAnalytics = sampleAnalytics != null;

  if (!hasFeed && !hasLeaderboard && !hasAnalytics) return null;

  let panelIndex = 0;

  return (
    <section className="border-y border-border-subtle bg-inverted-surface py-16 text-inverted-surface-foreground">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 className="text-balance text-center text-2xl font-bold sm:text-3xl">
          Built for <span className="text-accent-primary-label">competition</span>. Made for{" "}
          <span className="text-accent-primary-label">community</span>.
        </h2>

        <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {hasFeed && (
            <ShowcasePanel
              index={++panelIndex}
              title="Your feed"
              description="See what the community is predicting and join the conversation."
            >
              <div className="space-y-3">
                {feedPools.map((vm) => (
                  <PoolPreviewCard key={vm.poolId} viewModel={vm} />
                ))}
              </div>
            </ShowcasePanel>
          )}

          {hasLeaderboard && (
            <ShowcasePanel
              index={++panelIndex}
              title="Leaderboard"
              description="Settle rivalries with results, streaks, and long-term performance."
            >
              <div className="space-y-3">
                <Podium entries={leaderboard.slice(0, 3)} currentUserId={NIL_USER_ID} />
                <RankedList entries={leaderboard} currentUserId={NIL_USER_ID} />
              </div>
            </ShowcasePanel>
          )}

          {hasAnalytics && sampleAnalytics && (
            <ShowcasePanel
              index={++panelIndex}
              title="Analytics"
              description="Track your own prediction history and watch your record build over time."
            >
              <div className="space-y-3">
                {/* 2-column, not 3 — matches how the real /analytics page
                    actually lays out its metric cards on a phone-width
                    screen (verified live, logged in as this exact user).
                    A 3-up row only works at desktop widths; on a
                    300px-wide mockup it crushed every value into
                    unreadably small text. */}
                <div className="grid grid-cols-2 gap-2">
                  <MetricCard
                    label="Accuracy"
                    value={formatPickRecord(
                      sampleAnalytics.predictionAccuracy.correct,
                      sampleAnalytics.predictionAccuracy.total,
                    )}
                  />
                  <MetricCard label="Pools entered" value={String(sampleAnalytics.poolsEntered)} />
                  <MetricCard label="Current streak" value={`${sampleAnalytics.currentStreak}W`} />
                </div>
                <LineChartCard
                  title="Account balance"
                  variant="area"
                  points={sampleAnalytics.balancePoints}
                  valueFormatter={(v) => formatCents(v)}
                  emptyMessage="No activity yet."
                />
              </div>
            </ShowcasePanel>
          )}
        </div>
      </div>
    </section>
  );
}
