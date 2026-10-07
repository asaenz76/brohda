import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeagueCrest } from "@/components/LeagueCrest";
import { resetLeagueCrestReports, resolveLeagueIdentity } from "@/lib/sports-data/league-crest";

afterEach(() => {
  cleanup();
  resetLeagueCrestReports();
});

describe("resolveLeagueIdentity — the Game's own league name and crest, nothing derived from a Market", () => {
  it.each([
    ["NFL (self-hosted)", "NFL", "/logo-nfl.png"],
    ["NBA", "NBA", "https://media.api-sports.io/basketball/leagues/12.png"],
    ["NHL", "NHL", "https://media.api-sports.io/hockey/leagues/57.png"],
    ["MLB (the same provider fields — no new code path)", "MLB", "https://media.api-sports.io/baseball/leagues/1.png"],
  ])("%s", (_label, name, url) => {
    expect(resolveLeagueIdentity({ competitionName: name, competitionLogoUrl: url })).toEqual({ name, crestUrl: url });
  });

  it("a missing or unusable crest yields the name only, and is reported once per league (not per card)", () => {
    const report = vi.fn();
    for (const bad of [null, "", "javascript:alert(1)", "http://insecure.example/x.png", "//protocol-relative.example/x.png"]) {
      expect(resolveLeagueIdentity({ competitionName: "NBA", competitionLogoUrl: bad }, report)).toEqual({ name: "NBA", crestUrl: null });
    }
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toContain('"NBA"');
  });

  it("trims the name and treats a blank name as absent", () => {
    expect(resolveLeagueIdentity({ competitionName: "  NHL ", competitionLogoUrl: "/x.png" }, vi.fn()).name).toBe("NHL");
    expect(resolveLeagueIdentity({ competitionName: "   ", competitionLogoUrl: "/x.png" }, vi.fn()).name).toBeNull();
  });
});

describe("LeagueCrest", () => {
  it("renders the crest as a decorative, aspect-preserving image beside the league name as text", () => {
    const { container } = render(<LeagueCrest league={{ name: "NHL", crestUrl: "https://media.api-sports.io/hockey/leagues/57.png" }} />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://media.api-sports.io/hockey/leagues/57.png");
    expect(img).toHaveAttribute("alt", "");
    expect(img.className).toContain("object-contain");
    expect(screen.getByText("NHL")).toBeInTheDocument();
  });

  it("no crest: the league name as plain text, no image", () => {
    const { container } = render(<LeagueCrest league={{ name: "NBA", crestUrl: null }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("NBA")).toBeInTheDocument();
  });

  it("a crest that fails to load disappears — no broken-image icon — and the name stays", () => {
    const { container } = render(<LeagueCrest league={{ name: "NFL", crestUrl: "/missing.png" }} />);
    act(() => {
      fireEvent.error(container.querySelector("img")!);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("NFL")).toBeInTheDocument();
  });

  it("nothing at all when there is neither a name nor a usable crest", () => {
    const { container } = render(<LeagueCrest league={{ name: null, crestUrl: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
