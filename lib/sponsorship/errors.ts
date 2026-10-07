// Database function errors -> stable codes -> operator/sponsor-readable messages. A raised exception's message IS the code.
const MESSAGES: Record<string, string> = {
  sponsorship_disabled: "Sponsored Game Posts aren't open right now.",
  not_authorized: "You don't have access to do that.",
  sponsor_not_active: "This sponsor account isn't active.",
  inventory_unavailable: "That Game isn't available to sponsor (it may have just been taken).",
  not_editable: "This sponsorship can't be edited anymore.",
  invalid_transition: "That isn't possible in this sponsorship's current state.",
  incomplete_sponsorship: "Add the sponsor name, a logo and the destination link before submitting.",
  incomplete_promotion: "Finish the promotion details (title, description, official rules link and who runs it) before submitting.",
  price_locked: "The price can't change after payment.",
  price_missing: "This sponsorship has no price yet.",
  stale_revision: "The sponsor changed this while you were reviewing it. Reload and review the latest version.",
  campaign_window_passed: "This campaign's window has already ended.",
  post_not_valid: "The Game Post isn't published or the Game was cancelled.",
  reason_required: "A reason is required.",
  sponsorship_not_found: "Sponsorship not found.",
  post_not_found: "Game Post not found.",
  invalid_event: "Unknown payment event.",
};

export const SPONSORSHIP_ERROR_CODES = Object.keys(MESSAGES);

export class SponsorshipError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? MESSAGES[code] ?? "Something went wrong. Try again.");
    this.name = "SponsorshipError";
  }
}

/** Turns a Supabase/Postgres error into a SponsorshipError (unknown failures keep a generic message and never leak SQL details). */
export function toSponsorshipError(error: { message?: string; code?: string } | null | undefined): SponsorshipError {
  const raw = error?.message ?? "";
  const code = SPONSORSHIP_ERROR_CODES.find((c) => raw.includes(c));
  if (code) return new SponsorshipError(code);
  if (error?.code === "23505") return new SponsorshipError("inventory_unavailable");
  return new SponsorshipError("unknown");
}
