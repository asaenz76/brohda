import type { LandingStats } from "@/lib/landing/fetch";

export function BetaStats({ stats }: { stats: LandingStats }) {
  const items = [
    { label: "beta testers", value: stats.betaTesters },
    { label: "predictions made", value: stats.predictionsMade },
    { label: "pools completed", value: stats.poolsCompleted },
  ];

  // Only real, currently-true counts — no fabricated testimonials or
  // rounded-up numbers. A small real count is worth more than a vague one.
  if (items.every((i) => i.value === 0)) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <p className="text-center text-sm font-semibold uppercase tracking-wide text-text-muted">
        Built with our beta community
      </p>
      <div className="mt-6 grid grid-cols-3 gap-4 text-center">
        {items.map((item) => (
          <div key={item.label}>
            <p className="font-mono text-3xl font-bold tabular-nums text-text-primary sm:text-4xl">
              {item.value.toLocaleString()}
            </p>
            <p className="mt-1 text-sm text-text-secondary">{item.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
