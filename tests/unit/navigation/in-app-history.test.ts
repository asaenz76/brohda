import { describe, expect, it } from "vitest";
import { canGoBackInApp, emptyHistory, recordLocation, type InAppHistory } from "@/lib/navigation/in-app-history";

const walk = (steps: Array<[string, (boolean | "replace")?]>): InAppHistory => steps.reduce((h, [path, how]) => recordLocation(h, path, how === "replace" ? "replace" : how ? "history" : "push"), emptyHistory());

describe("in-app history — is there a page of ours to go back to?", () => {
  it("a deep link (the first page of the document) has nowhere in-app to go back to", () => {
    expect(canGoBackInApp(walk([["/markets/m1"]]))).toBe(false);
    expect(canGoBackInApp(emptyHistory())).toBe(false);
  });

  it("Feed → Post → Market: Back is available at each step after the first", () => {
    expect(canGoBackInApp(walk([["/feed"], ["/post/p1"]]))).toBe(true);
    expect(canGoBackInApp(walk([["/feed"], ["/post/p1"], ["/markets/m1"]]))).toBe(true);
  });

  it("Back (browser history) pops: Feed → Post → Market → Back → Post → Back → Feed, and then there is nothing further in-app", () => {
    const atPost = walk([["/feed"], ["/post/p1"], ["/markets/m1"], ["/post/p1", true]]);
    expect(atPost.stack).toEqual(["/feed", "/post/p1"]);
    expect(canGoBackInApp(atPost)).toBe(true);
    const atFeed = recordLocation(atPost, "/feed", "history");
    expect(atFeed.stack).toEqual(["/feed"]);
    expect(canGoBackInApp(atFeed)).toBe(false);
  });

  it("a deep link to a Post, then a Market, then Back: the Post is a real previous page, but after Back the Post is the first page again — its Back must use the fallback, not leave the app", () => {
    const atMarket = walk([["/post/p1"], ["/markets/m1"]]);
    expect(canGoBackInApp(atMarket)).toBe(true);
    const backAtPost = recordLocation(atMarket, "/post/p1", "history");
    expect(canGoBackInApp(backAtPost)).toBe(false);
  });

  it("Community → Post → Market → Back → Back lands on the Community", () => {
    const h = walk([["/community/capitals"], ["/post/p1"], ["/markets/m1"], ["/post/p1", true], ["/community/capitals", true]]);
    expect(h.stack).toEqual(["/community/capitals"]);
  });

  it("the same page twice (a tab change via the query string, or a refresh) adds no entry", () => {
    expect(walk([["/feed"], ["/feed"], ["/feed"]]).stack).toEqual(["/feed"]);
  });

  it("Forward is a normal step onward", () => {
    const h = walk([["/feed"], ["/post/p1"], ["/feed", true], ["/post/p1", true]]);
    expect(h.stack).toEqual(["/feed", "/post/p1"]);
  });

  it("a link to a page that is also two back is a new page, not a Back (only the browser's own Back pops)", () => {
    expect(walk([["/feed"], ["/post/p1"], ["/feed"]]).stack).toEqual(["/feed", "/post/p1", "/feed"]);
  });

  it("a Back control taking its fallback REPLACES the entry: a deep-linked Market → Back (fallback Post) → the Post is the first page, so its Back also takes a fallback instead of returning to the Market", () => {
    const h = walk([["/markets/m1"], ["/post/p1", "replace"]]);
    expect(h.stack).toEqual(["/post/p1"]);
    expect(canGoBackInApp(h)).toBe(false);
  });
});
