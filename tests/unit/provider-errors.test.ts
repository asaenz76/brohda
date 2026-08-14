import { describe, expect, it } from "vitest";
import { classifyProviderError, UnsupportedOperationError } from "@/lib/sports-data/provider-errors";

describe("classifyProviderError", () => {
  it("classifies UnsupportedOperationError as UNSUPPORTED_OPERATION", () => {
    expect(classifyProviderError(new UnsupportedOperationError("api_nfl", "getTeamSquad"))).toBe("UNSUPPORTED_OPERATION");
  });

  it("classifies a rate-limit message as RATE_LIMITED, not QUOTA_EXHAUSTED", () => {
    expect(classifyProviderError(new Error("Too many requests. You have exceeded the limit of requests per minute."))).toBe(
      "RATE_LIMITED",
    );
  });

  it("classifies a daily-quota message as QUOTA_EXHAUSTED", () => {
    expect(classifyProviderError(new Error("You have reached the request limit for the day, upgrade your plan"))).toBe(
      "QUOTA_EXHAUSTED",
    );
  });

  it("classifies an auth-failure message as AUTH_FAILED", () => {
    expect(classifyProviderError(new Error("Unauthorized: invalid API key"))).toBe("AUTH_FAILED");
  });

  it("classifies http.ts's PermanentProviderError message shape by status code", () => {
    expect(classifyProviderError(new Error("Provider returned permanent error 401"))).toBe("AUTH_FAILED");
    expect(classifyProviderError(new Error("Provider returned permanent error 403"))).toBe("AUTH_FAILED");
    expect(classifyProviderError(new Error("Provider returned permanent error 400"))).toBe("INVALID_REQUEST");
    expect(classifyProviderError(new Error("Provider returned permanent error 404"))).toBe("INVALID_REQUEST");
  });

  it("classifies a JSON-parse failure as MALFORMED_RESPONSE", () => {
    expect(classifyProviderError(new SyntaxError("Unexpected token < in JSON at position 0"))).toBe("MALFORMED_RESPONSE");
  });

  it("classifies a network-level failure as PROVIDER_UNAVAILABLE", () => {
    expect(classifyProviderError(new Error("fetch failed"))).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyProviderError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("PROVIDER_UNAVAILABLE");
  });

  it("falls back to UNKNOWN for anything unrecognized", () => {
    expect(classifyProviderError(new Error("something completely unexpected happened"))).toBe("UNKNOWN");
    expect(classifyProviderError("a plain string, not an Error")).toBe("UNKNOWN");
  });
});
