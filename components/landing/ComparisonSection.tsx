const ROWS: Array<[string, string]> = [
  ["Bet alone", "Predict with friends"],
  ["Repeated odds screens", "Community feed"],
  ["House-focused pricing", "Participant pools"],
  ["One-off tickets", "Public track record"],
  ["Transaction first", "Conversation first"],
];

export function ComparisonSection() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h2 className="text-center text-2xl font-bold text-text-primary sm:text-3xl">
        Predictions should feel social, not transactional.
      </h2>
      <p className="mt-2 text-center text-text-secondary">
        Brohda brings predictions into a community feed. Make your call, see where your friends
        stand, compete in pools, and build a track record over time.
      </p>
      <div className="mt-8 overflow-x-auto rounded-2xl border border-border-subtle">
        <table className="w-full min-w-[420px] text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-secondary text-text-muted">
              <th className="px-4 py-2.5 font-medium">Traditional experience</th>
              <th className="px-4 py-2.5 font-medium text-accent-primary">brohda.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {ROWS.map(([traditional, brohda]) => (
              <tr key={traditional}>
                <td className="px-4 py-2.5 text-text-secondary">{traditional}</td>
                <td className="px-4 py-2.5 font-medium text-text-primary">{brohda}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
