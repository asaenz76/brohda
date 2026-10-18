import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PredictionComposer } from "@/components/predictions/PredictionComposer";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import { commitPredictionAction } from "@/lib/actions/predictions";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/actions/predictions", () => ({ commitPredictionAction: vi.fn() }));

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(commitPredictionAction).mockReset();
  refresh.mockReset();
});

const teams = { homeTeamName: "Indianapolis Colts", awayTeamName: "Washington Commanders", sport: "american_football" };
const moneyline = getChoicePresentation({ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, ...teams }).choices;
const offer = { available: 47, allowedStakes: [1, 2, 3, 4, 5], canClaim: false };
// Display order is Away @ Home: Commanders first (NO), Colts second (YES).
const side = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const level = (n: number) => screen.getByRole("button", { name: `${n} Confidence` });
const committedOk = (selectedOutcome: "YES" | "NO", amount: number) => ({ success: true, error: null, outcome: "created", closed: false, committed: { predictionId: "p1", selectedOutcome, amount } }) as never;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("PredictionComposer — a prediction is a side AND Confidence", () => {
  it("choosing a side is local: nothing is sent, the levels are waiting, and the side can be switched freely", () => {
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    expect((screen.getAllByRole("button", { name: /^\d Confidence$/ }) as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
    side("Pick Washington Commanders to win");
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toHaveAttribute("aria-pressed", "true");
    side("Pick Indianapolis Colts to win");
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toHaveAttribute("aria-pressed", "false");
    expect(commitPredictionAction).not.toHaveBeenCalled();
  });

  it("there is NO separate confirm: tapping a level is the commitment, sent with the chosen side, that amount and one idempotency key", async () => {
    vi.mocked(commitPredictionAction).mockResolvedValue(committedOk("YES", 3));
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
    side("Pick Indianapolis Colts to win");
    fireEvent.click(level(3));
    expect(commitPredictionAction).toHaveBeenCalledTimes(1);
    expect(commitPredictionAction).toHaveBeenCalledWith({ marketId: "m1", selectedOutcome: "YES", amount: 3, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    await screen.findByText("You picked Indianapolis Colts.");
  });

  it("selecting only a Confidence level (no side) does nothing", () => {
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    fireEvent.click(level(3));
    expect(commitPredictionAction).not.toHaveBeenCalled();
  });

  it("while the prediction is being saved the levels are disabled with a subtle status, and a double tap sends ONE request", async () => {
    const d = deferred<never>();
    vi.mocked(commitPredictionAction).mockReturnValue(d.promise);
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    side("Pick Washington Commanders to win");
    fireEvent.click(level(2));
    fireEvent.click(level(2));
    fireEvent.click(level(5));
    expect(commitPredictionAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Saving your 🔥2 prediction/)).toBeInTheDocument();
    expect((screen.getAllByRole("button", { name: /^\d Confidence$/ }) as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toBeDisabled(); // the side can't change mid-save
    await act(async () => d.resolve(committedOk("NO", 2)));
    await screen.findByText("You picked Washington Commanders.");
  });

  it("success replaces the composer with the committed, locked prediction and re-reads the page in the background (sentiment, shell balance)", async () => {
    vi.mocked(commitPredictionAction).mockResolvedValue(committedOk("NO", 4));
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    side("Pick Washington Commanders to win");
    fireEvent.click(level(4));
    await screen.findByText("You picked Washington Commanders.");
    expect(screen.getByLabelText("4 Confidence, locked")).toBeInTheDocument();
    expect(screen.queryByText(/How confident/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pick / })).toBeNull(); // no "change your prediction" after a commitment
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("a rejection puts the composer back with the side still chosen, shows the reason, and creates nothing", async () => {
    vi.mocked(commitPredictionAction).mockResolvedValue({ success: false, error: "You only have 🔥1 available.", outcome: "insufficient", closed: false, committed: null, available: 1 } as never);
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    side("Pick Washington Commanders to win");
    fireEvent.click(level(5));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("You only have 🔥1 available.");
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toHaveAttribute("aria-pressed", "true");
    // The balance the database reported is what the levels now follow.
    expect(screen.getByRole("button", { name: "2 Confidence" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1 Confidence" })).toBeEnabled();
    expect(screen.queryByText(/Locked/)).toBeNull();
  });

  it("a network failure rolls back the same way, and the retry reuses the same idempotency key", async () => {
    vi.mocked(commitPredictionAction).mockRejectedValueOnce(new Error("offline"));
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    side("Pick Washington Commanders to win");
    fireEvent.click(level(2));
    await screen.findByRole("alert");
    vi.mocked(commitPredictionAction).mockResolvedValueOnce(committedOk("NO", 2));
    fireEvent.click(level(2));
    await screen.findByText("You picked Washington Commanders.");
    const [first, second] = vi.mocked(commitPredictionAction).mock.calls;
    expect(second[0].idempotencyKey).toBe(first[0].idempotencyKey);
  });

  it("when the database says the Market is closed (deadline, started, already predicted) the composer closes with the plain reason", async () => {
    vi.mocked(commitPredictionAction).mockResolvedValue({ success: false, error: "Picks are locked for this game.", outcome: "past_deadline", closed: true, committed: null } as never);
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    side("Pick Washington Commanders to win");
    fireEvent.click(level(1));
    await screen.findByText("Picks are locked for this game.");
    expect(screen.queryByRole("button", { name: /Confidence$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Pick / })).toBeNull();
  });

  it("zero available: no level can be chosen, 'You need Confidence' shows (with the Daily Claim path only when open), and no unbacked fallback exists", () => {
    const { unmount } = render(<PredictionComposer marketId="m1" choices={moneyline} offer={{ ...offer, available: 0, canClaim: true }} disabledReason={null} />);
    expect(screen.getByText(/You need Confidence to make a prediction/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Claim your Daily Confidence" })).toHaveAttribute("href", "/profile");
    side("Pick Washington Commanders to win");
    expect((screen.getAllByRole("button", { name: /^\d Confidence$/ }) as HTMLButtonElement[]).every((b) => b.disabled)).toBe(true);
    unmount();
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={{ ...offer, available: 0, canClaim: false }} disabledReason={null} />);
    expect(screen.queryByRole("link", { name: /Claim/ })).toBeNull();
    expect(screen.queryByText(/buy|purchase|checkout|USDT|top up/i)).toBeNull();
  });

  it("only levels within the available balance can be chosen, and the configured ladder (not a constant) decides which levels exist", () => {
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={{ available: 8, allowedStakes: [2, 5, 10], canClaim: false }} disabledReason={null} />);
    side("Pick Washington Commanders to win");
    expect(screen.getAllByRole("button", { name: /^\d+ Confidence$/ }).map((b) => [b.getAttribute("aria-label"), (b as HTMLButtonElement).disabled])).toEqual([
      ["2 Confidence", false],
      ["5 Confidence", false],
      ["10 Confidence", true],
    ]);
  });

  it("an old open pick is pre-selected and completes with a level; the Market's own reason (stale numbers) blocks everything and says why", () => {
    const { unmount } = render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} initialSelection="YES" legacyOpenPick />);
    expect(screen.getByText(/isn.t final yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "3 Confidence" })).toBeEnabled();
    unmount();
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason="This market's numbers haven't updated recently." />);
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toBeDisabled();
    expect(screen.getByText("This market's numbers haven't updated recently.")).toBeInTheDocument();
  });

  it("when predictions are unavailable (Confidence off) it says so and offers no levels", () => {
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={null} disabledReason={null} />);
    expect(screen.getByText("Predictions are paused right now.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^\d Confidence$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toBeDisabled();
  });

  it("is understandable to assistive technology: every level has text, the pending reason is announced, and the group names the Market", async () => {
    const d = deferred<never>();
    vi.mocked(commitPredictionAction).mockReturnValue(d.promise);
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} groupLabel="Moneyline" />);
    expect(screen.getAllByRole("button", { name: /^\d Confidence$/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["1 Confidence", "2 Confidence", "3 Confidence", "4 Confidence", "5 Confidence"]);
    expect(screen.getByRole("group", { name: "How confident are you? Moneyline" })).toHaveAttribute("aria-describedby");
    side("Pick Washington Commanders to win");
    fireEvent.click(level(1));
    expect(document.querySelector('[data-slot="composer-status"]')).toHaveAttribute("aria-live", "polite");
    expect(level(2)).toHaveAttribute("aria-describedby");
    await act(async () => d.resolve(committedOk("NO", 1)));
  });
});

describe("PredictionComposer — closes itself when the pick lock passes while the page is open", () => {
  afterEach(() => vi.useRealTimers());

  it("shows live controls before the lock, then the locked message at the lock instant (no tap needed), and re-reads the page", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T19:54:00.000Z"));
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} lockAt="2026-10-18T19:55:00.000Z" />);
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toBeEnabled();
    act(() => void vi.advanceTimersByTime(59_000));
    expect(screen.queryByText("Picks are locked for this game.")).toBeNull();
    act(() => void vi.advanceTimersByTime(1_000));
    expect(screen.getByText("Picks are locked for this game.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick Washington Commanders to win" })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("a lock that has already passed when the page renders closes at once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T20:09:00.000Z"));
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} lockAt="2026-10-18T19:55:00.000Z" />);
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByText("Picks are locked for this game.")).toBeInTheDocument();
  });

  it("without a lock time nothing changes", () => {
    vi.useFakeTimers();
    render(<PredictionComposer marketId="m1" choices={moneyline} offer={offer} disabledReason={null} />);
    act(() => void vi.advanceTimersByTime(10 * 60 * 60 * 1000));
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toBeEnabled();
  });
});
