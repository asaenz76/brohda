import { afterEach, describe, expect, it } from "vitest";
import { clientNetworkIdentity, limiterKey, networkIdentity } from "@/lib/rate-limit/key";

const headers = (init: Record<string, string>) => new Headers(init);

afterEach(() => {
  delete process.env.RATE_LIMIT_HMAC_SECRET;
  delete process.env.VERCEL;
});

describe("networkIdentity", () => {
  it("keeps an IPv4 address as itself", () => {
    expect(networkIdentity("203.0.113.9")).toBe("203.0.113.9");
    expect(networkIdentity(" 203.0.113.9 ")).toBe("203.0.113.9");
  });

  it("counts an IPv6 address as its /64, whatever the text form, so rotating inside a prefix cannot walk past a limit", () => {
    const a = networkIdentity("2001:db8:abcd:12:1:2:3:4");
    expect(a).toBe("v6:2001:db8:abcd:12");
    expect(networkIdentity("2001:0DB8:abcd:0012:ffff:ffff:ffff:ffff")).toBe(a);
    expect(networkIdentity("2001:db8:abcd:12::1")).toBe(a);
    expect(networkIdentity("[2001:db8:abcd:12::beef]")).toBe(a);
    expect(networkIdentity("2001:db8:abcd:13::1")).not.toBe(a);
  });

  it("handles compressed and edge forms", () => {
    expect(networkIdentity("::1")).toBe("v6:0:0:0:0");
    expect(networkIdentity("::")).toBe("v6:0:0:0:0");
    expect(networkIdentity("fe80::1%en0")).toBe("v6:fe80:0:0:0");
  });

  it("reads an IPv4-mapped IPv6 address as the IPv4 address it carries", () => {
    expect(networkIdentity("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(networkIdentity("::ffff:c633:6407")).toBe("198.51.100.7");
  });

  it("returns null for anything that is not an address", () => {
    for (const bad of [null, undefined, "", "unknown", "999.1.1.1", "1.2.3", "2001:db8::g", "1:2:3:4:5:6:7:8:9", "a::b::c", "<script>"]) expect(networkIdentity(bad)).toBeNull();
  });
});

describe("clientNetworkIdentity", () => {
  it("trusts x-forwarded-for's first entry on Vercel (which overwrites client-sent values)", () => {
    process.env.VERCEL = "1";
    expect(clientNetworkIdentity(headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientNetworkIdentity(headers({ "x-real-ip": "203.0.113.10" }))).toBe("203.0.113.10");
  });

  it("returns null anywhere else, so a header a client can set never picks its own bucket", () => {
    expect(clientNetworkIdentity(headers({ "x-forwarded-for": "203.0.113.9" }))).toBeNull();
    process.env.VERCEL = "0";
    expect(clientNetworkIdentity(headers({ "x-forwarded-for": "203.0.113.9" }))).toBeNull();
  });

  it("returns null when the header is missing or malformed", () => {
    process.env.VERCEL = "1";
    expect(clientNetworkIdentity(headers({}))).toBeNull();
    expect(clientNetworkIdentity(headers({ "x-forwarded-for": "not-an-ip" }))).toBeNull();
  });
});

describe("limiterKey", () => {
  it("never contains the value, is stable, and differs by namespace and by value", () => {
    const key = limiterKey("register", "someone@example.com");
    expect(key).toMatch(/^register:[0-9a-f]{32}$/);
    expect(key).not.toContain("someone");
    expect(limiterKey("register", "someone@example.com")).toBe(key);
    expect(limiterKey("login", "someone@example.com")).not.toBe(key.replace("register", "login"));
    expect(limiterKey("register", "other@example.com")).not.toBe(key);
  });

  it("is keyed when RATE_LIMIT_HMAC_SECRET is set: the same value gives a different bucket per secret", () => {
    const unkeyed = limiterKey("register-net", "203.0.113.9");
    process.env.RATE_LIMIT_HMAC_SECRET = "secret-one";
    const one = limiterKey("register-net", "203.0.113.9");
    process.env.RATE_LIMIT_HMAC_SECRET = "secret-two";
    const two = limiterKey("register-net", "203.0.113.9");
    expect(new Set([unkeyed, one, two]).size).toBe(3);
  });
});
