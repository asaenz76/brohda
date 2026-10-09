import { describe, expect, it } from "vitest";
import { accountRedirect, homePathFor, isMemberArea, isSponsorArea, isSponsorPublicPath, sponsorLoginHrefFor } from "@/lib/auth/account-routing";

describe("account routing: a login is a Member or a Sponsor, never both", () => {
  it("only /sponsor and below is the Sponsor area (not /sponsorship/click)", () => {
    expect(isSponsorArea("/sponsor")).toBe(true);
    expect(isSponsorArea("/sponsor/games")).toBe(true);
    expect(isSponsorArea("/sponsor/abc?x=1")).toBe(true);
    expect(isSponsorArea("/sponsorship/click/123")).toBe(false);
    expect(isSponsorArea("/feed")).toBe(false);
  });

  it("only the entry pages and the Sponsor Terms are public inside the Sponsor area", () => {
    for (const p of ["/sponsor/login", "/sponsor/signup", "/sponsor/verified", "/sponsor/terms", "/sponsor/login/"]) expect(isSponsorPublicPath(p), p).toBe(true);
    for (const p of ["/sponsor", "/sponsor/games", "/sponsor/profile", "/sponsor/login/x"]) expect(isSponsorPublicPath(p), p).toBe(false);
  });

  it("every Member-side area is recognised, the public pages are not", () => {
    for (const p of ["/feed", "/my-picks", "/activity", "/profile", "/admin", "/admin/sponsorship", "/community/x", "/discovery", "/markets/1", "/notifications", "/post/1", "/search", "/wallet", "/accept-terms"]) expect(isMemberArea(p), p).toBe(true);
    for (const p of ["/", "/login", "/register", "/terms", "/privacy", "/rules", "/how-it-works", "/sponsor", "/sponsorship/click/1", "/api/x"]) expect(isMemberArea(p), p).toBe(false);
  });

  it("a Sponsor is kept out of every Member area and sent to its own home", () => {
    for (const path of ["/feed", "/wallet", "/admin", "/post/1", "/notifications", "/profile", "/my-picks", "/community/a", "/search"]) {
      expect(accountRedirect({ path, signedIn: true, accountType: "SPONSOR", safeNext: null }), path).toBe("/sponsor");
    }
    expect(accountRedirect({ path: "/sponsor/games", signedIn: true, accountType: "SPONSOR", safeNext: null })).toBeNull();
    expect(accountRedirect({ path: "/sponsorship/click/1", signedIn: true, accountType: "SPONSOR", safeNext: null })).toBeNull();
  });

  it("a Member is kept out of the Sponsor area, but may see its public entry pages", () => {
    for (const path of ["/sponsor", "/sponsor/games", "/sponsor/profile", "/sponsor/123"]) expect(accountRedirect({ path, signedIn: true, accountType: "MEMBER", safeNext: null }), path).toBe("/feed");
    for (const path of ["/sponsor/login", "/sponsor/signup"]) expect(accountRedirect({ path, signedIn: true, accountType: "MEMBER", safeNext: null }), path).toBeNull();
    expect(accountRedirect({ path: "/feed", signedIn: true, accountType: "MEMBER", safeNext: null })).toBeNull();
  });

  it("a signed-out visitor to the Sponsor area goes to the SPONSOR login (with a safe return path), never the Member login", () => {
    expect(accountRedirect({ path: "/sponsor", signedIn: false, accountType: null, safeNext: null })).toBe("/sponsor/login");
    expect(accountRedirect({ path: "/sponsor/games", signedIn: false, accountType: null, safeNext: "/sponsor/games" })).toBe("/sponsor/login?next=%2Fsponsor%2Fgames");
    expect(accountRedirect({ path: "/sponsor/login", signedIn: false, accountType: null, safeNext: null })).toBeNull();
    expect(accountRedirect({ path: "/sponsor/signup", signedIn: false, accountType: null, safeNext: null })).toBeNull();
    expect(accountRedirect({ path: "/feed", signedIn: false, accountType: null, safeNext: null })).toBeNull(); // the Member proxy rules handle this
  });

  it("an unclassified login gets neither area's protected pages in the Sponsor area", () => {
    expect(accountRedirect({ path: "/sponsor", signedIn: true, accountType: null, safeNext: null })).toBe("/sponsor/login");
  });

  it("each account lands at its own home", () => {
    expect(homePathFor("SPONSOR")).toBe("/sponsor");
    expect(homePathFor("MEMBER")).toBe("/feed");
    expect(homePathFor(null)).toBe("/feed");
    expect(sponsorLoginHrefFor(null)).toBe("/sponsor/login");
  });
});
