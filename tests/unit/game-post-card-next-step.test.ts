import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: () => null }));

import { conversationNextStep } from "@/components/posts/GamePostCard";

type Item = Parameters<typeof conversationNextStep>[0];

function item(over: { viewerSelection?: "YES" | "NO" | null; commentCount?: number; yes?: number | null; no?: number | null; revealed?: boolean; status?: string } = {}): Item {
  return {
    internalStatus: over.status ?? "NOT_STARTED",
    commentCount: over.commentCount ?? 0,
    primaryMarket: {
      choices: [
        { outcome: "YES", label: "Chiefs" },
        { outcome: "NO", label: "Bills" },
      ],
      viewerSelection: over.viewerSelection === undefined ? "YES" : over.viewerSelection,
      yesPercent: over.yes === undefined ? 60 : over.yes,
      noPercent: over.no === undefined ? 40 : over.no,
      sentimentRevealed: over.revealed ?? true,
    },
  } as unknown as Item;
}

describe("conversationNextStep — what a Member who has picked is invited to do", () => {
  it("is nothing before a Pick, so the card stays Pick-first", () => {
    expect(conversationNextStep(item({ viewerSelection: null }), false)).toBeNull();
  });

  it("is nothing for a logged-out visitor", () => {
    expect(conversationNextStep(item(), true)).toBeNull();
  });

  it("invites the first comment when there are none", () => {
    const step = conversationNextStep(item({ commentCount: 0 }), false)!;
    expect(step.text).toBe("Say why");
    expect(step.label).toBe("Say why you picked Chiefs, in the Game's conversation");
    expect(step.text).not.toMatch(/picked/i); // the card already says "You picked …"; the link never repeats it as visible text
  });

  it("with comments, shows the real count and points to the other side only when someone really picked it", () => {
    expect(conversationNextStep(item({ commentCount: 3 }), false)?.text).toBe("3 comments · See who picked Bills");
    expect(conversationNextStep(item({ commentCount: 1 }), false)?.text).toBe("1 comment · See who picked Bills");
    expect(conversationNextStep(item({ commentCount: 3 }), false)?.label).toBe("3 comments, and see who picked Bills, in the Game's conversation");
  });

  it("never invents disagreement: nobody on the other side, or the sentiment not revealed", () => {
    expect(conversationNextStep(item({ commentCount: 2, yes: 100, no: 0 }), false)?.text).toBe("2 comments");
    expect(conversationNextStep(item({ commentCount: 2, yes: null, no: null }), false)?.text).toBe("2 comments");
    expect(conversationNextStep(item({ commentCount: 2, revealed: false }), false)?.text).toBe("2 comments");
  });

  it("names the other side from the viewer's own side", () => {
    expect(conversationNextStep(item({ viewerSelection: "NO", commentCount: 2, yes: 60, no: 40 }), false)?.text).toBe("2 comments · See who picked Chiefs");
  });

  it("is nothing once the Game is over", () => {
    expect(conversationNextStep(item({ status: "COMPLETED" }), false)).toBeNull();
    expect(conversationNextStep(item({ status: "CANCELLED", commentCount: 4 }), false)).toBeNull();
  });
});
