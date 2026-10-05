import { describe, expect, it } from "vitest";
import { deriveMonetaryActionState } from "@/lib/monetary/action-state";
import { formatBpsAsPercent } from "@/lib/utils/money";
import { NOTIFICATION_CENTER_TYPES } from "@/lib/notifications/center";
import type { MonetaryPosition, MonetaryPositionSettlement, MonetaryProposal } from "@/lib/monetary/types";

const VIEWER = "viewer";
const OTHER = "other";
const OTHER_PICK = "other-pick";
const VIEWER_PICK = "viewer-pick";

function proposal(overrides: Partial<MonetaryProposal>): MonetaryProposal {
  return {
    id: "p1",
    marketId: "m1",
    proposerUserId: VIEWER,
    recipientUserId: OTHER,
    proposerPredictionId: VIEWER_PICK,
    recipientPredictionId: OTHER_PICK,
    stake: 1000,
    status: "PENDING",
    positionId: null,
    ...overrides,
  } as MonetaryProposal;
}

const incoming = (overrides: Partial<MonetaryProposal> = {}) =>
  proposal({ proposerUserId: OTHER, recipientUserId: VIEWER, proposerPredictionId: OTHER_PICK, recipientPredictionId: VIEWER_PICK, ...overrides });

function derive(proposals: MonetaryProposal[], opts: { canProposeMoney?: boolean; moneyEnabled?: boolean; available?: number; pastCutoff?: boolean; positions?: MonetaryPosition[]; settlements?: MonetaryPositionSettlement[] } = {}) {
  return deriveMonetaryActionState({
    viewerId: VIEWER,
    participantPredictionId: OTHER_PICK,
    canProposeMoney: opts.canProposeMoney ?? false,
    proposals,
    positionsById: new Map((opts.positions ?? []).map((p) => [p.id, p])),
    settlementsByPositionId: new Map((opts.settlements ?? []).map((s) => [s.positionId, s])),
    viewerAvailableCents: opts.available ?? 5000,
    pastCutoff: opts.pastCutoff ?? false,
    ...(opts.moneyEnabled === undefined ? {} : { moneyEnabled: opts.moneyEnabled }),
  });
}

describe("deriveMonetaryActionState", () => {
  it("offers 'Put money on it' only when eligible and nothing is active", () => {
    expect(derive([], { canProposeMoney: true })).toEqual({ kind: "put_money_on_it", recipientPredictionId: OTHER_PICK });
    expect(derive([], { canProposeMoney: false })).toBeNull();
  });

  it("shows the proposer their own pending proposal", () => {
    expect(derive([proposal({})])).toEqual({ kind: "outgoing_pending", proposalId: "p1", stake: 1000 });
  });

  it("splits an incoming proposal on the viewer's CURRENT available balance — exactly enough counts as funded", () => {
    expect(derive([incoming()], { available: 1000 })).toEqual({ kind: "incoming_pending_funded", proposalId: "p1", stake: 1000 });
    expect(derive([incoming()], { available: 999 })).toEqual({ kind: "incoming_pending_unfunded", proposalId: "p1", stake: 1000 });
  });

  // PENDING is only expired in the database by the sweep (and lazily on an
  // accept attempt), so the UI must not offer Accept past cutoff.
  it("renders a PENDING proposal past cutoff as expired for both sides — no Accept, no Withdraw/Decline controls", () => {
    expect(derive([incoming()], { pastCutoff: true })).toEqual({ kind: "expired", stake: 1000 });
    expect(derive([proposal({})], { pastCutoff: true })).toEqual({ kind: "expired", stake: 1000 });
  });

  it("never expires a committed Position, however late", () => {
    const accepted = proposal({ status: "ACCEPTED", positionId: "pos1" });
    expect(derive([accepted], { pastCutoff: true })).toEqual({ kind: "committed", stake: 1000 });
  });

  it("shows settled outcomes from the viewer's side", () => {
    const accepted = proposal({ status: "ACCEPTED", positionId: "pos1" });
    const position = { id: "pos1" } as MonetaryPosition;
    const win = { positionId: "pos1", outcome: "PROPOSER_WINS", winnerUserId: VIEWER, winnerCreditAmount: 990, stake: 1000 } as MonetaryPositionSettlement;
    const loss = { ...win, outcome: "RECIPIENT_WINS", winnerUserId: OTHER } as MonetaryPositionSettlement;
    const voided = { ...win, outcome: "VOID", winnerUserId: null } as unknown as MonetaryPositionSettlement;
    expect(derive([accepted], { positions: [position], settlements: [win] })).toEqual({ kind: "settled_win", amount: 990 });
    expect(derive([accepted], { positions: [position], settlements: [loss] })).toEqual({ kind: "settled_loss", amount: 1000 });
    expect(derive([accepted], { positions: [position], settlements: [voided] })).toEqual({ kind: "settled_void" });
  });

  it("ignores declined, withdrawn and expired proposals (a fresh one may be offered)", () => {
    for (const status of ["DECLINED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(derive([proposal({ status })], { canProposeMoney: true })).toEqual({ kind: "put_money_on_it", recipientPredictionId: OTHER_PICK });
    }
  });

  it("ignores proposals belonging to a different participant's pair", () => {
    const unrelated = proposal({ recipientPredictionId: "someone-else-pick", recipientUserId: "someone-else" });
    expect(derive([unrelated], { canProposeMoney: true })).toEqual({ kind: "put_money_on_it", recipientPredictionId: OTHER_PICK });
  });
});

describe("formatBpsAsPercent", () => {
  it("renders basis points for people", () => {
    expect(formatBpsAsPercent(100)).toBe("1%");
    expect(formatBpsAsPercent(250)).toBe("2.5%");
    expect(formatBpsAsPercent(333)).toBe("3.33%");
    expect(formatBpsAsPercent(0)).toBe("0%");
    expect(formatBpsAsPercent(10000)).toBe("100%");
  });
});

describe("notification center", () => {
  it("lists the proposal-expired type, so a released hold is never a silent event", () => {
    expect(NOTIFICATION_CENTER_TYPES).toContain("MONETARY_PROPOSAL_EXPIRED");
  });
});

// Consumer money gating: switching optional money off stops NEW participation but must not strand an obligation.
describe("deriveMonetaryActionState — optional money switched off", () => {
  it("is unchanged when money is on (the default)", () => {
    expect(derive([incoming()], { available: 5000, moneyEnabled: true })).toEqual({ kind: "incoming_pending_funded", proposalId: "p1", stake: 1000 });
    expect(derive([incoming()], { available: 5000 })).toEqual({ kind: "incoming_pending_funded", proposalId: "p1", stake: 1000 });
  });

  it("an incoming pending offer can no longer be accepted or funded — only declined — whatever the viewer's balance", () => {
    for (const available of [0, 999, 1000, 5000]) {
      expect(derive([incoming()], { available, moneyEnabled: false })).toEqual({ kind: "incoming_pending_unavailable", proposalId: "p1", stake: 1000 });
    }
  });

  it("never offers a NEW 'Put money on it' to someone with nothing active (the participant discovery already withholds it)", () => {
    expect(derive([], { canProposeMoney: false, moneyEnabled: false })).toBeNull();
  });

  it("keeps existing obligations visible: a pending offer you sent (to withdraw), a committed Position, and a settled one", () => {
    expect(derive([proposal({})], { moneyEnabled: false })).toEqual({ kind: "outgoing_pending", proposalId: "p1", stake: 1000 });
    const position = { id: "pos1", settlementStatus: "COMMITTED" } as MonetaryPosition;
    expect(derive([proposal({ status: "ACCEPTED", positionId: "pos1" })], { moneyEnabled: false, positions: [position] })).toEqual({ kind: "committed", stake: 1000 });
  });

  it("an offer past its cutoff still reads as expired, not as a live offer", () => {
    expect(derive([incoming()], { moneyEnabled: false, pastCutoff: true })).toEqual({ kind: "expired", stake: 1000 });
  });
});
