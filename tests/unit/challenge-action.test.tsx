import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  callBSAction: vi.fn(),
  acceptChallengeAction: vi.fn(),
  declineChallengeAction: vi.fn(),
}));
vi.mock("@/lib/actions/challenges", () => actions);

import { ChallengeAction } from "@/components/predictions/ChallengeAction";

const challenge = { id: "c1" } as never;

beforeEach(() => {
  actions.callBSAction.mockReset();
  actions.acceptChallengeAction.mockReset();
  actions.declineChallengeAction.mockReset();
});
afterEach(() => cleanup());

describe("ChallengeAction", () => {
  it("shows Accept/Decline and the lock warning for an incoming Challenge", () => {
    render(<ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(screen.getByText("Accepting locks both predictions for this game.")).toBeInTheDocument();
  });

  // The real sibling-refresh bug: the row used to seed useState from its
  // prop, so when another row's Accept expired this one and the server
  // re-rendered it as "unavailable", the mounted row kept offering
  // Accept/Decline until a manual reload.
  it("follows the server-rendered state: a displaced sibling row loses Accept/Decline without remounting", () => {
    const { rerender } = render(<ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();

    rerender(<ChallengeAction marketId="m1" state={{ kind: "unavailable" }} />);

    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
    expect(screen.getByText("No longer available")).toBeInTheDocument();
    expect(screen.queryByText("Declined")).not.toBeInTheDocument();
  });

  it("drops Accept/Decline when the server re-renders a past-cutoff PENDING row as unavailable", () => {
    const { rerender } = render(<ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />);
    rerender(<ChallengeAction marketId="m1" state={{ kind: "unavailable" }} />);
    expect(screen.queryByRole("button", { name: /accept|decline/i })).not.toBeInTheDocument();
  });

  it("keeps showing 'Declined' after the server refreshes the row, instead of flipping straight to a Call BS button", async () => {
    actions.declineChallengeAction.mockResolvedValue({ error: null, challenge });
    const { rerender } = render(<ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    });
    await waitFor(() => expect(screen.getByText("Declined")).toBeInTheDocument());

    // After revalidation the server no longer sees a DECLINED row and offers a fresh Call BS.
    rerender(<ChallengeAction marketId="m1" state={{ kind: "call_bs", recipientPredictionId: "p1" }} />);
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Call BS" })).not.toBeInTheDocument();
  });

  it("moves keyboard focus to the status text that replaces the clicked buttons, and announces it as a status", async () => {
    actions.acceptChallengeAction.mockResolvedValue({ error: null, challenge });
    render(<ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />);
    const accept = screen.getByRole("button", { name: "Accept" });
    accept.focus();

    await act(async () => {
      fireEvent.click(accept);
    });

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Accepted");
    await waitFor(() => expect(status).toHaveFocus());
  });

  it("does not steal focus when the server changes a row the user never touched", () => {
    const { rerender } = render(
      <div>
        <button type="button">elsewhere</button>
        <ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />
      </div>,
    );
    screen.getByRole("button", { name: "elsewhere" }).focus();
    rerender(
      <div>
        <button type="button">elsewhere</button>
        <ChallengeAction marketId="m1" state={{ kind: "unavailable" }} />
      </div>,
    );
    expect(screen.getByRole("button", { name: "elsewhere" })).toHaveFocus();
  });

  it("treats a server verdict of 'no longer available' as final, and reports it as text, not colour", async () => {
    actions.acceptChallengeAction.mockResolvedValue({ error: "This Call BS is no longer available.", challenge });
    render(<ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No longer available"));
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("surfaces a client/permission error with role=alert and keeps the controls", async () => {
    actions.acceptChallengeAction.mockResolvedValue({ error: "This Call BS isn't addressed to you.", challenge: null });
    render(<ChallengeAction marketId="m1" state={{ kind: "incoming_pending", challengeId: "c1" }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("This Call BS isn't addressed to you.");
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  it("the server's accepted verdict beats a stale local Pending", async () => {
    actions.callBSAction.mockResolvedValue({ error: null, challenge });
    const { rerender } = render(<ChallengeAction marketId="m1" state={{ kind: "call_bs", recipientPredictionId: "p1" }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Call BS" }));
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pending"));

    rerender(<ChallengeAction marketId="m1" state={{ kind: "accepted" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Accepted");
  });

  it("labels a participant who is already in a Call BS, as plain status text with no controls", () => {
    render(<ChallengeAction marketId="m1" state={{ kind: "in_call_bs" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("In a Call BS");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
