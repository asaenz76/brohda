import { describe, expect, it } from "vitest";
import { loginHrefFor, registerHrefFor, sanitizeNextPath } from "@/lib/auth/safe-next";

describe("sanitizeNextPath — only same-origin internal paths survive", () => {
  it.each([
    ["/post/123", "/post/123"],
    ["/feed", "/feed"],
    ["/wallet", "/wallet"],
    ["/notifications", "/notifications"],
    ["/profile/someone", "/profile/someone"],
    ["/post/123?tab=comments", "/post/123?tab=comments"],
    ["/markets/abc-def", "/markets/abc-def"],
    ["/post/123#comments", "/post/123"], // a fragment is dropped, the page is kept
    ["/%2Fevil.com", "/%2Fevil.com"], // an encoded slash is just a path segment on this origin
  ])("keeps %s", (input, expected) => {
    expect(sanitizeNextPath(input)).toBe(expected);
  });

  it.each([
    ["an absolute URL", "https://evil.com/steal"],
    ["an absolute URL on the same host name", "https://brohda.com/feed"],
    ["a protocol-relative URL", "//evil.com"],
    ["a protocol-relative URL with a path", "//evil.com/feed"],
    ["a backslash trick", "/\\evil.com"],
    ["a double backslash", "\\\\evil.com"],
    ["a backslash anywhere", "/feed\\..\\evil"],
    ["javascript:", "javascript:alert(1)"],
    ["javascript: in caps", "JAVASCRIPT:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["a scheme-looking path without a leading slash", "evil.com/feed"],
    ["whitespace then a scheme", " https://evil.com"],
    ["a tab inside the scheme", "/\thttps://evil.com"],
    ["a newline (header injection)", "/feed\r\nSet-Cookie: x=1"],
    ["a NUL byte", "/feed\u0000.evil"],
    ["an empty string", ""],
    ["just a query", "?next=/feed"],
    ["a relative path", "feed"],
    ["a dot-dot relative path", "../feed"],
    ["an oversized value", `/${"a".repeat(3000)}`],
  ])("rejects %s", (_name, input) => {
    expect(sanitizeNextPath(input)).toBeNull();
  });

  it("rejects values that aren't strings", () => {
    for (const value of [undefined, null, 42, {}, [], ["/feed"], true]) expect(sanitizeNextPath(value)).toBeNull();
  });

  it("never returns an authentication page (no redirect loop)", () => {
    for (const path of ["/login", "/login?next=/feed", "/register", "/register/x", "/logout", "/reset-password", "/invite/abc"]) {
      expect(sanitizeNextPath(path), path).toBeNull();
    }
    // …but a page that merely starts with the same letters is fine.
    expect(sanitizeNextPath("/login-help")).toBe("/login-help");
  });

  it("whatever it returns is always a single-slash path that stays on this origin", () => {
    const attempts = ["/post/1", "//x", "/\\x", "/%5Cx", "/%2F%2Fx", "/./x", "/a/../b", "/x?y=//z", "/x?u=https://evil.com"];
    for (const attempt of attempts) {
      const out = sanitizeNextPath(attempt);
      if (out === null) continue;
      expect(out.startsWith("/") && !out.startsWith("//"), `${attempt} -> ${out}`).toBe(true);
      expect(new URL(out, "https://brohda.com").origin).toBe("https://brohda.com");
    }
  });
});

describe("loginHrefFor / registerHrefFor", () => {
  it("builds an encoded next for a safe path", () => {
    expect(loginHrefFor("/post/123")).toBe("/login?next=%2Fpost%2F123");
    expect(loginHrefFor("/post/123?x=1")).toBe("/login?next=%2Fpost%2F123%3Fx%3D1");
    expect(registerHrefFor("/post/123")).toBe("/register?next=%2Fpost%2F123");
  });

  it("falls back to the plain URL for anything missing or unsafe — a bad next never reaches the URL", () => {
    for (const bad of [null, undefined, "", "https://evil.com", "//evil.com", "javascript:alert(1)", "/login"]) {
      expect(loginHrefFor(bad)).toBe("/login");
      expect(registerHrefFor(bad)).toBe("/register");
    }
  });
});
