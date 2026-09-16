/** A network/5xx/429 failure — retried by the client, and never treated as evidence that previously-ingested data is wrong (roadmap STEP 14). */
export class PolymarketTransientError extends Error {}

/** A permanent 4xx (other than 429) — never retried. */
export class PolymarketPermanentError extends Error {}

/** The response body didn't match the documented Gamma shape closely enough to trust. */
export class PolymarketValidationError extends Error {}
