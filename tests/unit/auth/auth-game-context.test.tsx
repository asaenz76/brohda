import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthGameIntent } from "@/lib/auth/game-context";

vi.mock("@/lib/auth/game-context", () => ({ getAuthGameIntent: vi.fn() }));

import { AuthGameContext } from "@/components/auth/AuthGameContext";

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(getAuthGameIntent).mockReset();
});

async function show(next: string | null, action: "create" | "login") {
  render(await AuthGameContext({ next, action }));
}

describe("AuthGameContext — the Game (and the side) the visitor came for, as intent", () => {
  it("names the Game and the tapped side, and says the pick still has to be confirmed", async () => {
    vi.mocked(getAuthGameIntent).mockResolvedValue({ matchup: "Carolina Panthers @ Green Bay Packers", choiceLabel: "Green Bay Packers" });
    await show("/post/x?pick=YES", "create");
    expect(screen.getByText("Carolina Panthers @ Green Bay Packers")).toBeInTheDocument();
    expect(screen.getByText("You chose Green Bay Packers.")).toBeInTheDocument();
    expect(screen.getByText("Create your account, then confirm your pick.")).toBeInTheDocument();
  });

  it("never says the pick was made or saved", async () => {
    vi.mocked(getAuthGameIntent).mockResolvedValue({ matchup: "A @ B", choiceLabel: "B" });
    await show("/post/x?pick=YES", "create");
    expect(document.body.textContent).not.toMatch(/pick (is|was) (made|saved|in)|picked|saved/i);
  });

  it("uses the login wording on the login page", async () => {
    vi.mocked(getAuthGameIntent).mockResolvedValue({ matchup: "A @ B", choiceLabel: "A" });
    await show("/post/x?pick=NO", "login");
    expect(screen.getByText("Log in, then confirm your pick.")).toBeInTheDocument();
  });

  it("without a tapped side it shows the Game alone, with the plain line", async () => {
    vi.mocked(getAuthGameIntent).mockResolvedValue({ matchup: "A @ B", choiceLabel: null });
    await show("/post/x", "create");
    expect(screen.queryByText(/You chose/)).toBeNull();
    expect(screen.getByText("Create your account to make your pick on this game.")).toBeInTheDocument();
  });

  it("renders nothing when there is no Game", async () => {
    vi.mocked(getAuthGameIntent).mockResolvedValue(null);
    expect(await AuthGameContext({ next: null, action: "create" })).toBeNull();
  });
});
