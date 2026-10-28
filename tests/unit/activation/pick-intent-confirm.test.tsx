import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPickAction } from "@/lib/actions/predictions";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("@/lib/actions/predictions", () => ({ setPickAction: vi.fn() }));

import { PickIntentConfirm } from "@/components/posts/PickIntentConfirm";

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(setPickAction).mockReset();
  replace.mockReset();
  refresh.mockReset();
});

const ok = { success: true, error: null, outcome: "created", closed: false, selection: "YES" as const, cancelledChallenges: 0 };

describe("PickIntentConfirm — the tapped side, handed back as a question", () => {
  it("saves NOTHING by being shown: the Pick is made only by the Member pressing Confirm", () => {
    render(<PickIntentConfirm marketId="m1" outcome="YES" label="Carolina Panthers" postId="p1" />);
    expect(screen.getByText("You chose Carolina Panthers.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Confirm your pick" })).toBeInTheDocument();
    expect(setPickAction).not.toHaveBeenCalled();
  });

  it("Confirm makes exactly one Pick through the normal action, then drops the hint from the address and re-reads the page", async () => {
    vi.mocked(setPickAction).mockResolvedValue(ok);
    render(<PickIntentConfirm marketId="m1" outcome="YES" label="Carolina Panthers" postId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm your pick: Carolina Panthers" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/post/p1"));
    expect(setPickAction).toHaveBeenCalledTimes(1);
    expect(setPickAction).toHaveBeenCalledWith({ marketId: "m1", selectedOutcome: "YES", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(refresh).toHaveBeenCalled();
  });

  it("a Pick that cannot be made says why and stays put (nothing replaced, nothing refreshed)", async () => {
    vi.mocked(setPickAction).mockResolvedValue({ success: false, error: "Picks are locked for this game.", outcome: "market_ineligible", closed: true, selection: null, cancelledChallenges: 0 });
    render(<PickIntentConfirm marketId="m1" outcome="NO" label="Green Bay Packers" postId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm your pick/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Picks are locked for this game.");
    expect(replace).not.toHaveBeenCalled();
  });

  it("a thrown error is reported plainly, never as a silent success", async () => {
    vi.mocked(setPickAction).mockRejectedValue(new Error("network"));
    render(<PickIntentConfirm marketId="m1" outcome="YES" label="Panthers" postId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm your pick/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing changed");
    expect(replace).not.toHaveBeenCalled();
  });
});
