import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwoStepPickComposer } from "@/components/predictions/TwoStepPickComposer";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import { attachConfidenceAction, setPickAction } from "@/lib/actions/predictions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/actions/predictions", () => ({ setPickAction: vi.fn(), attachConfidenceAction: vi.fn() }));

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(setPickAction).mockReset();
  vi.mocked(attachConfidenceAction).mockReset();
  refresh.mockReset();
});

const teams = { homeTeamName: "Indianapolis Colts", awayTeamName: "Washington Commanders", sport: "american_football" };
const moneyline = getChoicePresentation({ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, ...teams }).choices;
const offer = { available: 47, allowedStakes: [1, 2, 3, 4, 5], canClaim: false, twoStep: true };
const team = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const level = (n: number) => screen.getByRole("button", { name: `${n} Confidence` });
const pickOk = (selection: "YES" | "NO", cancelledChallenges = 0) => ({ success: true, error: null, outcome: "created", closed: false, selection, cancelledChallenges });
const pickFail = (error: string, outcome: string, extra: Record<string, unknown> = {}) => ({ success: false, error, outcome, closed: false, selection: null, cancelledChallenges: 0, ...extra });
const attachOk = (amount: number) => ({ success: true, error: null, outcome: "created", closed: false, committed: { predictionId: "p1", selectedOutcome: "YES" as const, amount } });

describe("TwoStepPickComposer — a team Pick first, Confidence optional", () => {
  it("step 1 makes the pick on its own: no Confidence is needed, and no Confidence level exists until there is a pick", async () => {
    vi.mocked(setPickAction).mockResolvedValue(pickOk("YES"));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    expect(screen.queryByRole("button", { name: /^\d Confidence$/ })).toBeNull();
    team("Pick Indianapolis Colts to win");
    expect(setPickAction).toHaveBeenCalledWith({ marketId: "m1", selectedOutcome: "YES", idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await screen.findByText(/You can change your pick until it locks/);
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/How confident are you\?/)).toBeInTheDocument();
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(attachConfidenceAction).not.toHaveBeenCalled();
  });

  it("M7: the first Pick is acknowledged in plain words — made, and what it means for the Record — before anything about changing it or Confidence", async () => {
    vi.mocked(setPickAction).mockResolvedValue(pickOk("YES"));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    expect(document.querySelector('[data-slot="pick-made"]')).toBeNull();
    team("Pick Indianapolis Colts to win");
    const made = await screen.findByText("Pick made. It counts toward your Record when the game ends.");
    expect(made).toHaveAttribute("role", "status");
    // The existing hint is untouched, and comes after the acknowledgement.
    expect(screen.getByText("You can change your pick until it locks.")).toBeInTheDocument();
    expect(made.compareDocumentPosition(screen.getByText("You can change your pick until it locks.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the team can be switched before it locks: each tap is a new request (a fresh key), the other side is saved, and a cancelled Call BS is reported", async () => {
    vi.mocked(setPickAction).mockResolvedValueOnce(pickOk("YES")).mockResolvedValueOnce(pickOk("NO", 2));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    team("Pick Indianapolis Colts to win");
    await screen.findByText(/You can change your pick until it locks/);
    team("Pick Washington Commanders to win");
    await screen.findByText("Your change cancelled 2 Call BS challenges.");
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toHaveAttribute("aria-pressed", "true");
    const keys = vi.mocked(setPickAction).mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("tapping the side that is already picked sends nothing", async () => {
    vi.mocked(setPickAction).mockResolvedValue(pickOk("YES"));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="UNSTAKED_EDITABLE" canChangeTeam canAttachConfidence />);
    team("Pick Indianapolis Colts to win");
    expect(setPickAction).not.toHaveBeenCalled();
  });

  it("step 2 is optional: choosing a level attaches it, locks BOTH the team and the amount on screen, and says so", async () => {
    vi.mocked(attachConfidenceAction).mockResolvedValue(attachOk(3));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="UNSTAKED_EDITABLE" canChangeTeam canAttachConfidence />);
    fireEvent.click(level(3));
    expect(attachConfidenceAction).toHaveBeenCalledWith({ marketId: "m1", amount: 3, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await screen.findByText("You picked Indianapolis Colts.");
    expect(screen.getByText(/Confidence · Locked/)).toBeInTheDocument();
    expect(screen.getByText("Your team and your Confidence are locked.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pick .* to win/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^\d Confidence$/ })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("a double tap on a level sends ONE request", async () => {
    let resolve!: (v: ReturnType<typeof attachOk>) => void;
    vi.mocked(attachConfidenceAction).mockReturnValue(new Promise((r) => (resolve = r)));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="UNSTAKED_EDITABLE" canChangeTeam canAttachConfidence />);
    fireEvent.click(level(2));
    fireEvent.click(level(2));
    expect(attachConfidenceAction).toHaveBeenCalledTimes(1);
    resolve(attachOk(2));
    await screen.findByText(/Confidence · Locked/);
  });

  it("a pick locked by an accepted Call BS: the team buttons are locked, the optional Confidence control is still offered, and attaching does not change the team", async () => {
    vi.mocked(attachConfidenceAction).mockResolvedValue(attachOk(4));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="LOCKED_CALL_BS" canChangeTeam={false} canAttachConfidence />);
    expect(screen.getByText("Your team is locked by an accepted Call BS.")).toBeInTheDocument();
    for (const name of ["Pick Indianapolis Colts to win", "Pick Washington Commanders to win"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByText(/How confident are you\?/)).toBeInTheDocument();
    fireEvent.click(level(4));
    await screen.findByText(/Confidence · Locked/);
    expect(setPickAction).not.toHaveBeenCalled();
    expect(screen.getByText("You picked Indianapolis Colts.")).toBeInTheDocument();
  });

  it("when Confidence can no longer be added (the deadline passed) it says so instead of offering levels", () => {
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="LOCKED_CALL_BS" canChangeTeam={false} canAttachConfidence={false} />);
    expect(screen.getByText("Confidence can't be added to this pick anymore.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^\d Confidence$/ })).toBeNull();
  });

  it("a rejection restores the controls with the reason; nothing is shown as saved", async () => {
    vi.mocked(attachConfidenceAction).mockResolvedValue({ success: false, error: "You only have 1 Confidence available.", outcome: "insufficient", closed: false, committed: null, available: 1 });
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="UNSTAKED_EDITABLE" canChangeTeam canAttachConfidence />);
    fireEvent.click(level(5));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("You only have 1 Confidence available.");
    expect(screen.queryByText(/Confidence · Locked/)).toBeNull();
    expect(level(1)).toBeEnabled();
  });

  it("deadline UX: a refused change because T-10 passed closes the composer with the lock message (and keeps showing the pick)", async () => {
    vi.mocked(setPickAction).mockResolvedValue(pickFail("Picks are locked for this game.", "past_deadline", { closed: true, selection: "YES" }));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="UNSTAKED_EDITABLE" canChangeTeam canAttachConfidence />);
    team("Pick Washington Commanders to win");
    await screen.findByText("You picked Indianapolis Colts — Picks are locked for this game.");
    expect(screen.queryByRole("button", { name: /Pick .* to win/ })).toBeNull();
  });

  it("deadline UX: the composer closes itself at the lock instant without a request", async () => {
    vi.useFakeTimers();
    try {
      render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} lockAt={new Date(Date.now() + 5_000).toISOString()} />);
      expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(5_100);
      expect(screen.getByRole("status")).toHaveTextContent("Picks are locked for this game.");
      expect(setPickAction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a team locked server-side (an accepted Call BS arrived meanwhile) is shown as locked with the reason, not as a failure to retry", async () => {
    vi.mocked(setPickAction).mockResolvedValue(pickFail("Your pick is locked for this game.", "pick_locked", { closed: true, selection: "YES" }));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" pickState="UNSTAKED_EDITABLE" canChangeTeam canAttachConfidence />);
    team("Pick Washington Commanders to win");
    await waitFor(() => expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toBeDisabled());
    expect(screen.getByRole("alert")).toHaveTextContent("Your pick is locked for this game.");
  });

  it("with no Confidence available the pick is still possible and the Confidence step explains why it can't be added", async () => {
    vi.mocked(setPickAction).mockResolvedValue(pickOk("NO"));
    render(<TwoStepPickComposer marketId="m1" choices={moneyline} offer={{ ...offer, available: 0 }} disabledReason={null} />);
    team("Pick Washington Commanders to win");
    await screen.findByText(/You don't have enough Confidence to add some right now/);
    expect(setPickAction).toHaveBeenCalledTimes(1);
  });
});
