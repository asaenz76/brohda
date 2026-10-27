import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostCommentWithAuthor } from "@/lib/post-comments/types";
import type { ConversationSocial } from "@/lib/challenges/post-social";

vi.mock("@/lib/actions/post-comments", () => ({ addPostCommentAction: vi.fn(), removePostCommentAction: vi.fn() }));
vi.mock("@/lib/actions/challenges", () => ({ callBSAction: vi.fn(), acceptChallengeAction: vi.fn(), declineChallengeAction: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { PostConversation } from "@/components/posts/PostConversation";

const VIEWER = { id: "viewer", isModerator: false };

function comment(id: string, authorId: string, body: string, overrides: Partial<PostCommentWithAuthor> = {}): PostCommentWithAuthor {
  return {
    id,
    postId: "post-1",
    userId: authorId,
    parentCommentId: null,
    body,
    deletedAt: null,
    createdAt: new Date().toISOString(),
    author: { id: authorId, displayName: authorId[0].toUpperCase() + authorId.slice(1), username: authorId, avatarUrl: null },
    replies: [],
    ...overrides,
  };
}

const social: ConversationSocial = {
  marketId: "m1",
  viewer: { outcome: "YES", label: "Chiefs" },
  otherLabel: "Bills",
  byUserId: {
    viewer: { displayName: "Viewer", outcome: "YES", label: "Chiefs", relation: "self", action: null, headToHead: null },
    sam: { displayName: "Sam", outcome: "YES", label: "Chiefs", relation: "same", action: null, headToHead: null },
    maria: { displayName: "Maria", outcome: "NO", label: "Bills", relation: "opposite", action: { kind: "call_bs", recipientPredictionId: "pick-maria" }, headToHead: { wins: 3, losses: 1 } },
    ben: { displayName: "Ben", outcome: "NO", label: "Bills", relation: "opposite", action: { kind: "called_on_you" }, headToHead: null },
  },
};

afterEach(() => cleanup());

const thread = () => [
  comment("c1", "sam", "Chiefs in a blowout"),
  comment("c2", "maria", "Chiefs haven't beaten anyone good."),
  comment("c3", "maria", "And the defence is thin."),
  comment("c4", "ben", "Bills by a touchdown", { replies: [comment("r1", "sam", "Dream on", { parentCommentId: "c4" })] }),
];

function renderThread(s: ConversationSocial | null = social, comments = thread()) {
  return render(<PostConversation postId="post-1" viewer={VIEWER} initialComments={comments} reputationByUserId={{}} social={s} />);
}

describe("PostConversation — side-aware", () => {
  it("shows which side each commenter is arguing from, in text, with the other side marked; the Post never says \"You picked\" (it is not a prediction surface)", () => {
    renderThread();
    expect(screen.queryByText(/You picked/)).toBeNull();
    const sides = [...document.querySelectorAll('[data-slot="comment-side"]')].map((n) => `${n.getAttribute("data-relation")}|${n.textContent}`);
    expect(sides).toContain("same|Picked Chiefs");
    expect(sides).toContain("opposite|Picked Bills · Other side");
  });

  it("shows no sides and no Call BS controls when the viewer has not picked (commit-before-crowd)", () => {
    renderThread(null);
    expect(document.querySelector('[data-slot="comment-side"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /call bs/i })).toBeNull();
    expect(screen.queryByText(/say why/i)).toBeNull();
    expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
  });

  it("puts Call BS inside the opposing fan's comment, named for who it is about", () => {
    renderThread();
    const mariaFirst = screen.getByText("Chiefs haven't beaten anyone good.").closest("div.flex-1") as HTMLElement;
    const button = within(mariaFirst).getByRole("button", { name: "Call BS" });
    expect(button).toHaveAttribute("aria-description", "Call BS on Maria"); // the name stays "Call BS"; who it is about is its description
    expect(within(mariaFirst).getByText("Your Call BS record against Maria: 3 wins, 1 loss")).toBeInTheDocument();
  });

  it("offers one Call BS control per opposing Member, on their first comment only", () => {
    renderThread();
    expect(screen.getAllByRole("button", { name: "Call BS" })).toHaveLength(1);
    const second = screen.getByText("And the defence is thin.").closest("div.flex-1") as HTMLElement;
    expect(within(second).queryByRole("button", { name: /call bs/i })).toBeNull();
  });

  it("never offers Call BS on a same-side Member or on yourself", () => {
    renderThread();
    const sam = screen.getByText("Chiefs in a blowout").closest("div.flex-1") as HTMLElement;
    expect(within(sam).queryByRole("button", { name: /call bs/i })).toBeNull();
  });

  it("a Call BS already on the viewer is named in the row, not answerable there (it is answered in Your Call BS)", () => {
    renderThread();
    const ben = screen.getByText("Bills by a touchdown").closest("div.flex-1") as HTMLElement;
    expect(within(ben).getByRole("status")).toHaveTextContent("Called BS on you");
    expect(within(ben).queryByRole("button", { name: /accept|decline/i })).toBeNull();
  });

  it("lets the viewer show only the other side's threads, without hiding anything permanently", () => {
    renderThread();
    const filter = screen.getByRole("button", { name: /Show only Bills fans \(2\)/ });
    expect(filter).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Chiefs in a blowout")).toBeInTheDocument();

    fireEvent.click(filter);
    expect(screen.getByRole("button", { name: /Showing Bills fans \(2\)/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Chiefs in a blowout")).toBeNull();
    expect(screen.getByText("Chiefs haven't beaten anyone good.")).toBeInTheDocument();
    // A same-side reply stays in the thread it answers.
    expect(screen.getByText("Dream on")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Showing Bills fans/ }));
    expect(screen.getByText("Chiefs in a blowout")).toBeInTheDocument();
  });

  it("offers no filter when nobody on the other side has commented", () => {
    renderThread(social, [comment("c1", "sam", "Chiefs in a blowout")]);
    expect(screen.queryByRole("button", { name: /Show only/ })).toBeNull();
  });

  it("does not offer Call BS from a deleted comment", () => {
    renderThread(social, [comment("c2", "maria", "x", { deletedAt: new Date().toISOString() })]);
    expect(screen.queryByRole("button", { name: /call bs/i })).toBeNull();
    expect(screen.getByText("[comment deleted]")).toBeInTheDocument();
  });

  it("invites a Member who has picked to say why: an empty thread and a prompt above the composer", () => {
    const { unmount } = renderThread(social, []);
    expect(screen.getByText("Nobody has said anything yet. Say why you picked Chiefs.")).toBeInTheDocument();
    unmount();
    renderThread();
    expect(screen.getByText("Say why you picked Chiefs.")).toBeInTheDocument();
  });

  it("keeps the original empty state before a Pick", () => {
    renderThread(null, []);
    expect(screen.getByText("Be the first to comment.")).toBeInTheDocument();
  });
});
