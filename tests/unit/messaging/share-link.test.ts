import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const { parseBrohdaLink, isUuid } = await import("@/lib/messaging/share");

const ID = "0f3a8c1e-5b7d-4a9e-8c21-9d4e6f7a1b2c";

describe("parseBrohdaLink", () => {
  it("recognises a Game Post and a Market link, from a full URL or a bare path", () => {
    expect(parseBrohdaLink(`https://brohda.com/post/${ID}`)).toEqual({ type: "POST", ref: ID });
    expect(parseBrohdaLink(`/post/${ID}`)).toEqual({ type: "POST", ref: ID });
    expect(parseBrohdaLink(`https://brohda.com/markets/${ID}/`)).toEqual({ type: "MARKET", ref: ID });
    expect(parseBrohdaLink(`  /markets/${ID}  `)).toEqual({ type: "MARKET", ref: ID });
  });

  it("lowercases the id, ignores the host and query, and accepts only those two paths", () => {
    expect(parseBrohdaLink(`https://example.com/post/${ID.toUpperCase()}?x=1#y`)).toEqual({ type: "POST", ref: ID });
    for (const bad of [`/profile/${ID}`, `/post/${ID}/comments`, `/post/not-a-uuid`, `/post/`, "", "javascript:alert(1)", `data:text/html,/post/${ID}`, "https://brohda.com/feed"]) {
      expect(parseBrohdaLink(bad), bad).toBeNull();
    }
  });

  it("isUuid accepts only real UUIDs", () => {
    expect(isUuid(ID)).toBe(true);
    for (const bad of ["", "abc", ID + "x", null, undefined, 5, "0f3a8c1e5b7d4a9e8c219d4e6f7a1b2c"]) expect(isUuid(bad as string), String(bad)).toBe(false);
  });
});
