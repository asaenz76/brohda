// X.5.11 — always labeled as an estimate; the backend is authoritative at
// lock time. The actual numbers now live inline on each PoolOptionButton
// (percentage + "Win $X"), live-updated in real time — this is just the
// shared disclaimer underneath them.
export function PotentialPayoutFooter() {
  return (
    <p className="border-t border-border-subtle pt-2 text-xs text-text-muted">
      Estimate only. Your final share depends on the pool at lock time.
    </p>
  );
}
