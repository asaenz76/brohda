import { describe, expect, it } from "vitest";
import { errorMessage } from "@/lib/utils/error-message";

describe("errorMessage", () => {
  it("reads a real Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  // Supabase/PostgREST errors are plain objects — `instanceof Error` is false and
  // String() is "[object Object]" — but they carry the RPC's own raised text.
  it("reads the .message of a plain Supabase-style error object", () => {
    expect(errorMessage({ message: "not_recipient", code: "P0001", details: null, hint: null })).toBe("not_recipient");
  });

  it("never produces the useless '[object Object]' for an object that has a message", () => {
    expect(errorMessage({ message: "insufficient_available_balance" })).not.toBe("[object Object]");
  });

  it("falls back to String() for everything else", () => {
    expect(errorMessage("plain string")).toBe("plain string");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage({ message: "" })).toBe("[object Object]");
    expect(errorMessage({ message: 5 })).toBe("[object Object]");
  });
});
