import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  proposeMoneyAction: vi.fn(),
  acceptMonetaryProposalAction: vi.fn(),
  declineMonetaryProposalAction: vi.fn(),
  withdrawMonetaryProposalAction: vi.fn(),
}));
vi.mock("@/lib/actions/monetary-proposals", () => actions);

import { MonetaryProposalAction, type MonetaryActionContext } from "@/components/predictions/MonetaryProposalAction";

const context: MonetaryActionContext = { opponentName: "Louis", yourPickLabel: "Eagles do not win", theirPickLabel: "Eagles win", feeBps: 100, availableCents: 5000, minStakeCents: 100, maxStakeCents: 10000 };
const proposal = { id: "p1", stake: 1000 } as never;

beforeEach(() => Object.values(actions).forEach((fn) => fn.mockReset()));
afterEach(() => cleanup());

describe("MonetaryProposalAction — sending", () => {
  it("tells the sender, before they send, that the amount is held and what happens if they lose", () => {
    render(<MonetaryProposalAction marketId="m1" state={{ kind: "put_money_on_it", recipientPredictionId: "r1" }} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Put money on it" }));

    expect(screen.getByLabelText(/amount to put on it/i)).toBeInTheDocument();
    const help = screen.getByText(/sending holds this amount from your balance/i);
    expect(help).toHaveTextContent("Between $1.00 and $100.00");
    expect(help).toHaveTextContent("You have $50.00 available, so the most you can put on it is $50.00");
    expect(help).toHaveTextContent("If they accept and you lose, you pay it");
    expect(screen.getByLabelText(/amount to put on it/i)).toHaveAccessibleDescription(/sending holds this amount/i);
  });

  it("names the exact amount on the Send button once it is valid", () => {
    render(<MonetaryProposalAction marketId="m1" state={{ kind: "put_money_on_it", recipientPredictionId: "r1" }} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Put money on it" }));
    fireEvent.change(screen.getByLabelText(/amount to put on it/i), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Send $10.00" })).toBeEnabled();
  });

  it("blocks sending more than the available balance, says so, and marks the field invalid", () => {
    render(<MonetaryProposalAction marketId="m1" state={{ kind: "put_money_on_it", recipientPredictionId: "r1" }} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Put money on it" }));
    fireEvent.change(screen.getByLabelText(/amount to put on it/i), { target: { value: "75" } });
    expect(screen.getByText("That's more than the $50.00 you have available.")).toBeInTheDocument();
    expect(screen.getByLabelText(/amount to put on it/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(actions.proposeMoneyAction).not.toHaveBeenCalled();
  });

  it("after sending, states that the stake is held until the opponent answers, and offers Withdraw", async () => {
    actions.proposeMoneyAction.mockResolvedValue({ error: null, proposal });
    render(<MonetaryProposalAction marketId="m1" state={{ kind: "put_money_on_it", recipientPredictionId: "r1" }} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Put money on it" }));
    fireEvent.change(screen.getByLabelText(/amount to put on it/i), { target: { value: "10" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send $10.00" }));
    });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("$10.00 pending — held until Louis answers");
    await waitFor(() => expect(status).toHaveFocus());
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("after withdrawing, says the hold was released — and never offers a composer with an empty recipient id", async () => {
    actions.withdrawMonetaryProposalAction.mockResolvedValue({ error: null, proposal });
    render(<MonetaryProposalAction marketId="m1" state={{ kind: "outgoing_pending", proposalId: "p1", stake: 1000 }} context={context} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Withdrawn — your hold was released");
    expect(screen.queryByRole("button", { name: "Put money on it" })).not.toBeInTheDocument();
  });
});

describe("MonetaryProposalAction — stake limits", () => {
  const open = (ctx: MonetaryActionContext = context) => {
    render(<MonetaryProposalAction marketId="m1" state={{ kind: "put_money_on_it", recipientPredictionId: "r1" }} context={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: "Put money on it" }));
    return screen.getByLabelText(/amount to put on it/i);
  };
  const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

  it("shows the minimum, the maximum and the available balance before anything is typed", () => {
    open();
    expect(screen.getByText(/Between \$1\.00 and \$100\.00/)).toBeInTheDocument();
  });

  it("makes the effective ceiling min(maximum, available) understandable — a high maximum never implies funds", () => {
    open({ ...context, availableCents: 2500 });
    expect(screen.getByText(/the most you can put on it is \$25\.00/)).toBeInTheDocument();
    cleanup();
    open({ ...context, availableCents: 90000 });
    expect(screen.getByText(/the most you can put on it is \$100\.00/)).toBeInTheDocument();
  });

  it("accepts exactly the minimum and exactly the maximum (when the balance covers it)", () => {
    const input = open({ ...context, availableCents: 90000 });
    type(input, "1");
    expect(screen.getByRole("button", { name: "Send $1.00" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    type(input, "100");
    expect(screen.getByRole("button", { name: "Send $100.00" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects below the minimum with the amount in plain currency, tied to the field, as an alert", () => {
    const input = open();
    type(input, "0.50");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The minimum is $1.00.");
    expect(alert).not.toHaveTextContent(/cents|stake_below/i);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/The minimum is \$1\.00\./);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("rejects above the maximum even when the balance would cover it", () => {
    const input = open({ ...context, availableCents: 90000 });
    type(input, "100.01");
    expect(screen.getByRole("alert")).toHaveTextContent("The maximum is $100.00.");
    expect(input).toHaveAccessibleDescription(/The maximum is \$100\.00\./);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("when the balance is the binding limit, says so in terms of the balance, not the maximum", () => {
    const input = open({ ...context, availableCents: 2500 });
    type(input, "30");
    expect(screen.getByRole("alert")).toHaveTextContent("That's more than the $25.00 you have available.");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("with less available than the minimum, explains why and offers funding instead of an unusable Send", () => {
    open({ ...context, availableCents: 50 });
    expect(screen.getByText(/The minimum is \$1\.00 and you have \$0\.50 available/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fund your wallet" })).toHaveAttribute("href", "/wallet");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("surfaces a server-side refusal (the authority) as an alert, even if the client let it through", async () => {
    actions.proposeMoneyAction.mockResolvedValue({ error: "The maximum is $100.00.", proposal: null });
    const input = open();
    type(input, "50");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send $50.00" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("The maximum is $100.00.");
  });
});

describe("MonetaryProposalAction — accepting real money", () => {
  const funded = { kind: "incoming_pending_funded", proposalId: "p1", stake: 1000 } as const;

  it("shows the stake and opponent in plain text beside Accept, not as a bare number", () => {
    render(<MonetaryProposalAction marketId="m1" state={funded} context={context} />);
    expect(screen.getByText(/Louis put \$10\.00 on it\./)).toBeInTheDocument();
    expect(screen.getByText(/holds \$10\.00 of your balance/)).toBeInTheDocument();
  });

  it("does NOT commit on the first click — Accept opens an explicit confirmation", async () => {
    render(<MonetaryProposalAction marketId="m1" state={funded} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(actions.acceptMonetaryProposalAction).not.toHaveBeenCalled();

    const group = screen.getByRole("group", { name: "Confirm $10.00 against Louis" });
    expect(group).toHaveTextContent("Accept $10.00 against Louis?");
    expect(group).toHaveTextContent("You picked Eagles do not win. Louis picked Eagles win.");
    expect(group).toHaveTextContent("This is real money");
    expect(group).toHaveTextContent("$10.00 of your balance is held as soon as you confirm");
    expect(group).toHaveTextContent("If you win, you get $10.00 from Louis, minus a 1% fee");
    expect(group).toHaveTextContent("If you lose, you pay $10.00");
    expect(group).toHaveTextContent("It can't be undone");
  });

  it("states the real configured fee, and omits the fee clause entirely at 0%", () => {
    const { unmount } = render(<MonetaryProposalAction marketId="m1" state={funded} context={{ ...context, feeBps: 250 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(screen.getByRole("group")).toHaveTextContent("minus a 2.5% fee");
    unmount();
    render(<MonetaryProposalAction marketId="m1" state={funded} context={{ ...context, feeBps: 0 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(screen.getByRole("group")).not.toHaveTextContent(/fee/i);
  });

  it("Back leaves the proposal untouched; Confirm is the only thing that accepts", async () => {
    actions.acceptMonetaryProposalAction.mockResolvedValue({ error: null, proposal, position: {} });
    render(<MonetaryProposalAction marketId="m1" state={funded} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(actions.acceptMonetaryProposalAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm — put $10.00 on it" }));
    });
    expect(actions.acceptMonetaryProposalAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("$10.00 on the line")).toBeInTheDocument();
  });

  it("a server refusal at confirm time returns to the row with an alert, not a silent success", async () => {
    actions.acceptMonetaryProposalAction.mockResolvedValue({ error: "You don't have enough available balance to cover this stake.", proposal, position: null });
    render(<MonetaryProposalAction marketId="m1" state={funded} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("enough available balance");
    expect(screen.queryByText("$10.00 on the line")).not.toBeInTheDocument();
  });
});

describe("MonetaryProposalAction — recipient without funds", () => {
  it("keeps the proposal visible, shows the stake, balance and shortfall, links to funding, and has no Accept", () => {
    render(<MonetaryProposalAction marketId="m1" state={{ kind: "incoming_pending_unfunded", proposalId: "p1", stake: 1000 }} context={{ ...context, availableCents: 300 }} />);
    expect(screen.getByText(/Louis put \$10\.00 on it\./)).toBeInTheDocument();
    expect(screen.getByText(/You have \$3\.00 available — not enough available balance\. Add at least \$7\.00\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fund your wallet" })).toHaveAttribute("href", "/wallet");
    expect(screen.getByText(/funding never accepts it for you/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
  });
});

describe("MonetaryProposalAction — follows the server", () => {
  it("a proposal the server now reports as expired loses Accept/Decline without remounting", () => {
    const { rerender } = render(<MonetaryProposalAction marketId="m1" state={{ kind: "incoming_pending_funded", proposalId: "p1", stake: 1000 }} context={context} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    rerender(<MonetaryProposalAction marketId="m1" state={{ kind: "expired", stake: 1000 }} context={context} />);
    expect(screen.queryByRole("button", { name: /accept|decline/i })).not.toBeInTheDocument();
    expect(screen.getByText(/proposal expired — any hold is released/)).toBeInTheDocument();
  });

  it("an unfunded proposal becomes funded when the server re-renders with the new balance", () => {
    const { rerender } = render(<MonetaryProposalAction marketId="m1" state={{ kind: "incoming_pending_unfunded", proposalId: "p1", stake: 1000 }} context={{ ...context, availableCents: 0 }} />);
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    rerender(<MonetaryProposalAction marketId="m1" state={{ kind: "incoming_pending_funded", proposalId: "p1", stake: 1000 }} context={{ ...context, availableCents: 1000 }} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument(); // still needs an explicit click
    expect(actions.acceptMonetaryProposalAction).not.toHaveBeenCalled();
  });

  it("settled and committed states are viewer-relative and carry their meaning in words", () => {
    const { rerender } = render(<MonetaryProposalAction marketId="m1" state={{ kind: "settled_win", amount: 990 }} context={context} />);
    expect(screen.getByText("Won $9.90")).toBeInTheDocument();
    rerender(<MonetaryProposalAction marketId="m1" state={{ kind: "settled_loss", amount: 1000 }} context={context} />);
    expect(screen.getByText("Lost $10.00")).toBeInTheDocument();
    rerender(<MonetaryProposalAction marketId="m1" state={{ kind: "settled_void" }} context={context} />);
    expect(screen.getByText("Void — hold released")).toBeInTheDocument();
  });
});

describe("MonetaryProposalAction — money switched off, incoming offer", () => {
  const unavailable = { kind: "incoming_pending_unavailable", proposalId: "p1", stake: 1000 } as const;

  it("offers only Decline: no Accept, no 'Fund your wallet', no stake or fee copy", () => {
    const { container } = render(<MonetaryProposalAction marketId="m1" state={unavailable} context={context} />);
    expect(screen.getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /accept|confirm/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /fund/i })).toBeNull();
    expect(container.textContent).toContain("Louis sent an offer of $10.00.");
    expect(container.textContent).not.toMatch(/fee|fund|matching it|available|put .* on it/i);
  });

  it("declining releases the sender's hold through the existing action and confirms in words", async () => {
    actions.declineMonetaryProposalAction.mockResolvedValue({ error: null });
    render(<MonetaryProposalAction marketId="m1" state={unavailable} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(actions.declineMonetaryProposalAction).toHaveBeenCalledWith("p1", "m1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Declined — nothing was held");
    expect(actions.acceptMonetaryProposalAction).not.toHaveBeenCalled();
  });
});
