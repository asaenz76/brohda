import { describe, expect, it } from "vitest";
import { isValidTransition } from "@/lib/pools/transitions";

describe("isValidTransition (spec §11.5)", () => {
  it("allows the documented happy path", () => {
    expect(isValidTransition("DRAFT", "OPEN")).toBe(true);
    expect(isValidTransition("OPEN", "LOCKED")).toBe(true);
    expect(isValidTransition("LOCKED", "AWAITING_RESULT")).toBe(true);
    expect(isValidTransition("AWAITING_RESULT", "READY_FOR_REVIEW")).toBe(true);
    expect(isValidTransition("READY_FOR_REVIEW", "SETTLED")).toBe(true);
  });

  it("allows LOCKED -> CANCELLED as the below-minimum-entries extension (spec §16.8)", () => {
    expect(isValidTransition("LOCKED", "CANCELLED")).toBe(true);
  });

  it("allows the anomaly void paths", () => {
    expect(isValidTransition("LOCKED", "VOIDED")).toBe(true);
    expect(isValidTransition("AWAITING_RESULT", "VOIDED")).toBe(true);
    expect(isValidTransition("READY_FOR_REVIEW", "VOIDED")).toBe(true);
  });

  it("allows the reversal paths, including REVERSAL_FAILED_MANUAL_REVIEW's two exits", () => {
    expect(isValidTransition("SETTLED", "SETTLEMENT_REVERSED")).toBe(true);
    expect(isValidTransition("SETTLED", "REVERSAL_FAILED_MANUAL_REVIEW")).toBe(true);
    expect(isValidTransition("REVERSAL_FAILED_MANUAL_REVIEW", "SETTLEMENT_REVERSED")).toBe(true);
    expect(isValidTransition("REVERSAL_FAILED_MANUAL_REVIEW", "SETTLED")).toBe(true);
    expect(isValidTransition("SETTLEMENT_REVERSED", "READY_FOR_REVIEW")).toBe(true);
  });

  it("rejects arbitrary/backwards transitions", () => {
    expect(isValidTransition("OPEN", "SETTLED")).toBe(false);
    expect(isValidTransition("SETTLED", "OPEN")).toBe(false);
    expect(isValidTransition("DRAFT", "LOCKED")).toBe(false);
  });

  it("terminal statuses have no outgoing transitions", () => {
    expect(isValidTransition("VOIDED", "OPEN")).toBe(false);
    expect(isValidTransition("CANCELLED", "OPEN")).toBe(false);
  });
});
