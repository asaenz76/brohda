import { describe, expect, it } from "vitest";
import { firstVisibleCommentByAuthor, flattenThread, visibleCommenterIds } from "@/lib/post-comments/commenters";
import type { PostCommentWithAuthor } from "@/lib/post-comments/types";

function comment(id: string, authorId: string, overrides: Partial<PostCommentWithAuthor> = {}): PostCommentWithAuthor {
  return {
    id,
    postId: "post-1",
    userId: authorId,
    parentCommentId: null,
    body: id,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    author: { id: authorId, displayName: authorId, username: authorId, avatarUrl: null },
    replies: [],
    ...overrides,
  };
}

describe("the Post conversation's members", () => {
  const thread = [
    comment("a1", "ana", { replies: [comment("b1", "ben", { parentCommentId: "a1" }), comment("a2", "ana", { parentCommentId: "a1" })] }),
    comment("c1", "cy", { deletedAt: "2026-01-02T00:00:00Z" }),
    comment("d1", "dee", { hiddenByBlock: true }),
    comment("b2", "ben"),
  ];

  it("reads a thread in order: a comment, its replies, the next comment", () => {
    expect(flattenThread(thread).map((c) => c.id)).toEqual(["a1", "b1", "a2", "c1", "d1", "b2"]);
  });

  it("puts a Member's Call BS control on their FIRST visible comment only", () => {
    expect([...firstVisibleCommentByAuthor(thread)]).toEqual([
      ["a1", "ana"],
      ["b1", "ben"],
    ]);
  });

  it("does not count a deleted comment or one hidden because the viewer blocked its author", () => {
    expect([...visibleCommenterIds(thread)].sort()).toEqual(["ana", "ben"]);
  });

  it("a Member whose earlier comment was deleted is placed on their next visible one", () => {
    const t = [comment("x1", "xi", { deletedAt: "2026-01-02T00:00:00Z" }), comment("x2", "xi")];
    expect([...firstVisibleCommentByAuthor(t)]).toEqual([["x2", "xi"]]);
  });
});
