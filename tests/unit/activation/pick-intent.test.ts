import { describe, expect, it } from "vitest";
import { parsePickIntent, postIdFromNext, postIntentPath } from "@/lib/auth/pick-intent";
import { loginHrefFor, registerHrefFor, sanitizeNextPath } from "@/lib/auth/safe-next";

const ID = "0f6d2c1e-8a3b-4c52-9d41-7e5f8a1b2c3d";

describe("parsePickIntent — a hint, never an instruction", () => {
  it("accepts exactly YES or NO, in any case", () => {
    expect(parsePickIntent("YES")).toBe("YES");
    expect(parsePickIntent("no")).toBe("NO");
    expect(parsePickIntent([" yes "])).toBe("YES");
  });
  it.each([undefined, null, "", "MAYBE", "YES;DROP", "1", ["x", "YES"], 42, {}])("ignores %j", (value) => {
    expect(parsePickIntent(value as never)).toBeNull();
  });
});

describe("postIntentPath — the path sign-up returns the visitor to", () => {
  it("is the Game's own Post with the side as a query hint", () => {
    expect(postIntentPath(ID, "YES")).toBe(`/post/${ID}?pick=YES`);
    expect(registerHrefFor(postIntentPath(ID, "NO"))).toBe(`/register?next=${encodeURIComponent(`/post/${ID}?pick=NO`)}`);
    expect(loginHrefFor(postIntentPath(ID, "NO"))).toBe(`/login?next=${encodeURIComponent(`/post/${ID}?pick=NO`)}`);
  });
  it("refuses anything that is not a plain id token (no path, query, host or traversal)", () => {
    for (const bad of ["", "a/b", "../x", "x?y=1", "x#y", "//evil.com", "http://evil.com", "a b", "x".repeat(65), "x\n"]) expect(postIntentPath(bad, "YES"), bad).toBeNull();
  });
  it("what it builds always survives the open-redirect guard", () => {
    expect(sanitizeNextPath(postIntentPath(ID, "YES"))).toBe(`/post/${ID}?pick=YES`);
  });
});

describe("postIdFromNext — naming the Game on the sign-up screen", () => {
  it("reads the Post id from a safe /post path, with or without the hint", () => {
    expect(postIdFromNext(`/post/${ID}`)).toBe(ID);
    expect(postIdFromNext(`/post/${ID}?pick=YES`)).toBe(ID);
    expect(postIdFromNext(`/post/${ID}#conversation`)).toBe(ID);
  });
  it("is null for everything else, including every unsafe or foreign target", () => {
    for (const next of [null, undefined, "", "/feed", "/profile", "/post/", "/post/a/b", "//evil.com/post/x", "https://evil.com/post/x", "/post/x\\y", "javascript:alert(1)", "/login", "/register?next=/post/x"]) expect(postIdFromNext(next), String(next)).toBeNull();
  });
});
