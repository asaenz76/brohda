/**
 * The real shape of a Supabase RPC error — the reason errorMessage exists.
 * Server actions map an RPC's own `raise exception '<code>'` to friendly copy
 * by that code, so if the code can't be read back, every such error silently
 * degrades to a generic message (and job failures read "[object Object]").
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { errorMessage } from "@/lib/utils/error-message";
import { declineMonetaryProposal, withdrawMonetaryProposal } from "@/lib/monetary/repository";
import { acceptCallBS } from "@/lib/challenges/repository";

const admin = getTestAdminClient();

describe("errorMessage on real RPC errors", () => {
  it("a raw Supabase RPC error is NOT an Error instance, and String() is useless — but errorMessage recovers the raised code", async () => {
    const { error } = await admin.rpc("decline_monetary_proposal", { p_proposal_id: randomUUID(), p_recipient_user_id: randomUUID() }).single();
    expect(error).toBeTruthy();
    expect(error instanceof Error).toBe(false);
    expect(String(error)).toBe("[object Object]");
    expect(errorMessage(error)).toBe("proposal_not_found");
  });

  it("errors thrown by the repository functions carry the raised code that the actions map to copy", async () => {
    await expect(declineMonetaryProposal(randomUUID(), randomUUID())).rejects.toSatisfy((e: unknown) => errorMessage(e) === "proposal_not_found");
    await expect(withdrawMonetaryProposal(randomUUID(), randomUUID())).rejects.toSatisfy((e: unknown) => errorMessage(e) === "proposal_not_found");
    await expect(acceptCallBS(randomUUID(), randomUUID())).rejects.toSatisfy((e: unknown) => errorMessage(e) === "challenge_not_found");
  });
});
