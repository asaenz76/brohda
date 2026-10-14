import { describe, expect, it } from "vitest";
import { hideBlockedAuthors } from "@/lib/post-comments/block-view";
import type { PostCommentWithAuthor } from "@/lib/post-comments/types";

function comment(id: string, userId: string, replies: PostCommentWithAuthor[] = [], parent: string | null = null): PostCommentWithAuthor {
  return {
    id, postId: "p", userId, parentCommentId: parent, body: `body-${id}`, deletedAt: null, createdAt: "2026-01-01T00:00:00Z",
    author: { id: userId, displayName: `name-${userId}`, username: userId, avatarUrl: null }, replies,
  };
}

describe("hideBlockedAuthors (a Member block, from the blocker's own view)", () => {
  it("returns the tree untouched when the viewer blocked nobody", () => {
    const tree = [comment("1", "a", [comment("2", "b", [], "1")])];
    expect(hideBlockedAuthors(tree, new Set())).toBe(tree);
  });

  it("drops a blocked Member's top-level comment when nobody else replied, and their replies anywhere", () => {
    const tree = [comment("1", "blocked"), comment("2", "ok", [comment("3", "blocked", [], "2"), comment("4", "ok2", [], "2")])];
    const out = hideBlockedAuthors(tree, new Set(["blocked"]));
    expect(out.map((c) => c.id)).toEqual(["2"]);
    expect(out[0].replies.map((r) => r.id)).toEqual(["4"]);
  });

  it("keeps a placeholder (no text, no identity) when others replied beneath a blocked comment", () => {
    const tree = [comment("1", "blocked", [comment("2", "ok", [], "1")])];
    const [only] = hideBlockedAuthors(tree, new Set(["blocked"]));
    expect(only.hiddenByBlock).toBe(true);
    expect(only.body).toBe("");
    expect(only.author.displayName).not.toContain("name-blocked");
    expect(only.author.username).toBeNull();
    expect(only.replies.map((r) => r.id)).toEqual(["2"]);
  });

  it("never mutates the input (the comment itself is unchanged for everyone else)", () => {
    const tree = [comment("1", "blocked", [comment("2", "ok", [], "1")])];
    const snapshot = JSON.stringify(tree);
    hideBlockedAuthors(tree, new Set(["blocked"]));
    expect(JSON.stringify(tree)).toBe(snapshot);
  });
});
