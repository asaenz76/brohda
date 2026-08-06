// Same shape as lib/profiles/options.ts's preset arrays — a single source
// of truth for the fixed set of payment rails, shared by validation
// schemas, server actions, and both the admin settings UI and the player
// wallet form. Order matches the DB enum's declaration order.
export const PAYMENT_METHODS = ["USDC", "USDT", "VENMO", "CASHAPP", "ZELLE", "OTHER"] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  USDC: "USDC",
  USDT: "USDT",
  VENMO: "Venmo",
  CASHAPP: "CashApp",
  ZELLE: "Zelle",
  OTHER: "Other",
};

// Brohda reviews every deposit manually — there is no on-chain lookup or
// payment-provider webhook for any rail, so whatever the sender submits
// here is the *only* evidence an admin ever has to check against. What's
// actually reliable differs by rail:
//   - crypto: the transaction hash is the one thing that lets an admin
//     verify a deposit against a block explorer, so it's required and
//     format-checked (not just non-empty).
//   - Venmo/Cash App/Zelle: each hands the sender a confirmation number at
//     the moment of payment, so requiring it is realistic, not just
//     bureaucratic.
//   - OTHER: an admin-configured catch-all with no predictable receipt
//     shape (it might not even involve a "confirmation number" concept) —
//     the only rail where an empty reference is honest, not a gap.
export type PaymentReferenceRequirement = "crypto_hash" | "reference" | "optional";

export const PAYMENT_REFERENCE_REQUIREMENT: Record<PaymentMethod, PaymentReferenceRequirement> = {
  USDC: "crypto_hash",
  USDT: "crypto_hash",
  VENMO: "reference",
  CASHAPP: "reference",
  ZELLE: "reference",
  OTHER: "optional",
};

// Deliberately shape-checking, not chain-specific verification (that would
// be a real verification system — out of scope). No wrapping capture group
// or anchors: used both as the core of the server-side RegExp below and,
// verbatim, as an HTML `pattern` attribute (the browser implicitly wraps
// pattern strings in `^(?:...)$`), so client and server can never drift.
//   - `0x` + 64 hex chars: EVM chains (Ethereum, BSC, Polygon, ...)
//   - bare 64 hex chars: Tron/Bitcoin-style chains, or an EVM hash pasted
//     without its 0x prefix
//   - 43-88 base58 chars: Solana-style signatures
export const CRYPTO_TX_HASH_PATTERN =
  "0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,88}";
export const CRYPTO_TX_HASH_REGEX = new RegExp(`^(?:${CRYPTO_TX_HASH_PATTERN})$`);

export const PAYMENT_REFERENCE_LABEL: Record<PaymentMethod, string> = {
  USDC: "Transaction hash",
  USDT: "Transaction hash",
  VENMO: "Venmo confirmation number",
  CASHAPP: "Cash App confirmation number",
  ZELLE: "Zelle confirmation number",
  OTHER: "Payment reference (optional)",
};

export const PAYMENT_REFERENCE_PLACEHOLDER: Record<PaymentMethod, string> = {
  USDC: "e.g. 0xabc123... (the on-chain transaction hash)",
  USDT: "e.g. 0xabc123... (the on-chain transaction hash)",
  VENMO: "e.g. the confirmation number from your Venmo receipt",
  CASHAPP: "e.g. the confirmation number from your Cash App receipt",
  ZELLE: "e.g. the confirmation number your bank gave you",
  OTHER: "e.g. a screenshot reference or note for the admin",
};

export const PAYMENT_REFERENCE_HELP: Record<PaymentMethod, string | null> = {
  USDC: "We verify crypto deposits on-chain, so this is required.",
  USDT: "We verify crypto deposits on-chain, so this is required.",
  VENMO: "Required so we can match your payment to this request.",
  CASHAPP: "Required so we can match your payment to this request.",
  ZELLE: "Required so we can match your payment to this request.",
  OTHER: null,
};
