// What the database functions answer, and the plain words a Member reads for each. Pure and client-safe. `unavailable` is deliberately ONE message for every reason a Member cannot be messaged
// (they blocked you, the account is inactive, it is not a Member) so the wording never reveals which.

export type MessagingOutcome =
  | "sent"
  | "messaging_disabled"
  | "self"
  | "unavailable"
  | "blocked_by_you"
  | "empty"
  | "too_long"
  | "request_limit"
  | "request_pending_accept_first"
  | "duplicate_message"
  | "rate_limited"
  | "restricted"
  | "not_found"
  | "unsent"
  | "unsend_disabled"
  | "window_expired"
  | "accepted"
  | "declined"
  | "not_pending"
  | "reported"
  | "already_reported"
  | "own_message"
  | "invalid_share"
  | "share_unavailable"
  | "error";

const COPY: Record<MessagingOutcome, string> = {
  sent: "Sent.",
  messaging_disabled: "Messaging isn't available right now.",
  self: "You can't message yourself.",
  unavailable: "You can't message this Member.",
  blocked_by_you: "You've blocked this Member. Unblock them to message them.",
  empty: "Write a message first.",
  too_long: "That message is too long.",
  request_limit: "You've sent the most requests allowed to this Member. You can message them once they accept.",
  request_pending_accept_first: "This Member sent you a request. Accept it to reply.",
  duplicate_message: "You just sent that.",
  rate_limited: "You're going too fast. Wait a moment and try again.",
  restricted: "New Message Requests are paused on your account for now. You can still message Members you already talk to.",
  not_found: "That isn't available.",
  unsent: "Message deleted.",
  unsend_disabled: "Messages can't be deleted right now.",
  window_expired: "It's too late to delete that message.",
  accepted: "Request accepted.",
  declined: "Request declined.",
  not_pending: "That request has already been answered.",
  reported: "Thanks. Brohda will review this.",
  already_reported: "You've already reported this.",
  own_message: "You can't report your own message.",
  invalid_share: "That can't be shared.",
  share_unavailable: "That isn't available to share.",
  error: "Something went wrong. Try again.",
};

export function messagingOutcomeCopy(outcome: string | undefined, maxLength?: number): string {
  if (outcome === "too_long" && maxLength) return `That message is too long. The limit is ${maxLength.toLocaleString("en-US")} characters.`;
  return COPY[(outcome ?? "error") as MessagingOutcome] ?? COPY.error;
}

/** Outcomes that mean the thing the Member asked for happened. */
export function isMessagingSuccess(outcome: string | undefined): boolean {
  return outcome === "sent" || outcome === "unsent" || outcome === "accepted" || outcome === "declined" || outcome === "reported";
}
