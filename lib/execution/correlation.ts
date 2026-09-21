// Milestone 5.5 (Execution Controls, Reconciliation & Operational Safety).
// One provider-neutral correlation strategy (STEP 19): generated once, when
// a Quote is first requested, and carried forward unchanged onto the
// confirming OrderIntent, every execution_audit_events row for that
// journey, and any reconciliation record — never regenerated at a later
// layer, which would destroy traceability. Ownership: the Quote row is the
// source of truth (execution_quotes.correlation_id); every downstream
// consumer reads it from there rather than minting its own.
//
// Survives retries: a duplicate confirmation attempt (same idempotency key)
// resolves to the same OrderIntent row, which was created with the same
// Quote's correlation_id — no new id is generated on a retry.

export function generateCorrelationId(): string {
  return crypto.randomUUID();
}
