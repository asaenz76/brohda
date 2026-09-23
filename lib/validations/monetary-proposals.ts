import { z } from "zod";

// Milestone R9 §63-64. The only client-supplied identifiers for creation
// are the recipient's Pick id, the stake, and an optional source free
// Challenge id (§10-11 escalation) — proposer identity/Pick/Market/
// selection are always server-derived, never accepted here. Stake is
// integer cents only (§20) — `z.number().int()` rejects any fractional
// value at the boundary, before it ever reaches propose_money().

export const proposeMoneySchema = z
  .object({
    recipientPredictionId: z.string().uuid(),
    stake: z.number().int().positive(),
    sourceChallengeId: z.string().uuid().nullish(),
  })
  .strict();

export type ProposeMoneyInput = z.infer<typeof proposeMoneySchema>;

export const respondToMonetaryProposalSchema = z
  .object({
    proposalId: z.string().uuid(),
  })
  .strict();

export type RespondToMonetaryProposalInput = z.infer<typeof respondToMonetaryProposalSchema>;
