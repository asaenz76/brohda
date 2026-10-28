import { describe, expect, it } from "vitest";
import { parsePickIntent, postIdFromNext, pickIntentFromNext, postIntentPath } from "@/lib/auth/pick-intent";
import { loginHrefFor, registerHrefFor, sanitizeNextPath } from "@/lib/auth/safe-next";

const ID = "0f6d2c1e-8a3b-4c52-9d41-7e5f8a1b2c3d";

describe("parsePickIntent — a hint, never an instruction", () => {
  it("accepts exactly the strings YES and NO", () => {
    expect(parsePickIntent("YES")).toBe("YES");
    expect(parsePickIntent("NO")).toBe("NO");
  });
  it.each([undefined, null, "", "MAYBE", "yes", "no", "Yes", " YES", "YES ", "YES;DROP", "1", ["x", "YES"], ["YES"], ["YES", "NO"], 42, {}])("ignores %j", (value) => {
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

describe("pickIntentFromNext — the side a visitor tapped, read back off the safe return path", () => {
  it("reads the hint carried in the return path", () => {
    expect(pickIntentFromNext(`/post/${ID}?pick=YES`)).toBe("YES");
    expect(pickIntentFromNext(`/post/${ID}?pick=NO`)).toBe("NO");
    expect(parsePickIntent(pickIntentFromNext(`/post/${ID}?pick=NO`))).toBe("NO");
  });
  it("is null when there is no hint, or it is ambiguous (a repeated ?pick=)", () => {
    expect(pickIntentFromNext(`/post/${ID}`)).toBeNull();
    expect(pickIntentFromNext(`/post/${ID}?pick=YES&pick=NO`)).toBeNull();
    expect(pickIntentFromNext(`/post/${ID}?other=YES`)).toBeNull();
  });
  it("is null for every unsafe or foreign target, so a hand-made link can never name a side", () => {
    for (const next of [null, undefined, "", 42, "https://evil.com/post/x?pick=YES", "//evil.com/?pick=YES", "/post/x\\y?pick=YES", "/register?pick=YES"]) expect(pickIntentFromNext(next), String(next)).toBeNull();
  });
  it("hands back whatever the value is: only exactly YES or NO survives parsePickIntent", () => {
    expect(parsePickIntent(pickIntentFromNext(`/post/${ID}?pick=yes`))).toBeNull();
    expect(parsePickIntent(pickIntentFromNext(`/post/${ID}?pick=MAYBE`))).toBeNull();
  });
});
