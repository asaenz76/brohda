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
