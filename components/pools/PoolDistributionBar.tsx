interface DistributionOption {
  label: string;
  percentage: number | null;
}

// X.5.10: aggregate distribution, post-vote only — percentages arrive
// already privacy-filtered from the view-model (null pre-entry).
export function PoolDistributionBar({ options }: { options: DistributionOption[] }) {
  const visible = options.filter((o): o is { label: string; percentage: number } => o.percentage != null);
  if (visible.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-secondary" aria-hidden="true">
        {visible.map((option, i) => (
          <div
            key={option.label}
            className={i % 2 === 0 ? "bg-accent-primary" : "bg-border-strong"}
            style={{ width: `${option.percentage}%` }}
          />
        ))}
      </div>
      <p className="text-sm font-medium text-text-secondary">
        Community sentiment: {visible.map((o) => `${o.label} ${o.percentage}%`).join("  |  ")}
      </p>
    </div>
  );
}
