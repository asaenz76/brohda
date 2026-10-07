import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SportIcon, hasSportIcon } from "@/components/identity/SportIcon";
import { CommunityMark } from "@/components/identity/CommunityMark";
import { DiscoveryRow } from "@/components/discovery/DiscoveryRow";
import { PublicCommunityRow } from "@/components/discovery/PublicCommunityRow";
import { SPORT_CONFIGS } from "@/lib/sports-data/sport-registry";
import type { CommunityListItem } from "@/lib/communities/discovery";

vi.mock("@/components/communities/CommunityFollowButton", () => ({ CommunityFollowButton: () => <button>Follow</button> }));
vi.mock("server-only", () => ({}));
afterEach(() => cleanup());

const item = (over: Partial<CommunityListItem>): CommunityListItem => ({ id: "c1", slug: "hockey", type: "SPORT", displayName: "Hockey", logoUrl: null, sportKey: "hockey", isFollowing: false, mostRecentPostAt: null, ...over });
const markup = (sport: string) => {
  const { container, unmount } = render(<SportIcon sport={sport} />);
  const html = container.innerHTML;
  unmount();
  return html;
};

describe("sport icons", () => {
  it("every sport in the shared registry has its own artwork (so none falls back to the neutral mark)", () => {
    for (const c of SPORT_CONFIGS) expect(hasSportIcon(c.sport), c.sport).toBe(true);
  });

  it("each sport's icon is different from every other's, and from the neutral fallback", () => {
    const sports = SPORT_CONFIGS.map((c) => c.sport);
    const html = [...sports, "some_future_sport"].map(markup);
    expect(new Set(html.map((h) => h.replace(/data-sport="[^"]*"/, ""))).size).toBe(sports.length + 1);
  });

  it("is decorative (hidden from assistive technology), themeable (currentColor) and sizeable by its container", () => {
    const { container } = render(<SportIcon sport="basketball" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("data-sport", "basketball");
    expect(svg.getAttribute("class")).toContain("size-full");
  });

  it("an unknown or missing sport renders the neutral mark, never another sport's icon and never nothing", () => {
    expect(markup("curling")).not.toBe(markup("hockey"));
    expect(render(<SportIcon sport={null} />).container.querySelector("svg")).not.toBeNull();
  });
});

describe("CommunityMark — one mark for every Community", () => {
  it("a team or league with a logo shows its crest, never a sport icon", () => {
    const { container } = render(<CommunityMark logoUrl="https://example.test/crest.png" name="Boston Bruins" sportKey={null} className="size-8" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "https://example.test/crest.png");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("a sport (no crest) shows its icon in a round chip of the requested size", () => {
    const { container } = render(<CommunityMark logoUrl={null} name="Hockey" sportKey="hockey" className="size-8" />);
    expect(container.querySelector('[data-testid="sport-icon"]')).toHaveAttribute("data-sport", "hockey");
    expect(container.firstElementChild?.className).toContain("size-8");
    expect(container.firstElementChild?.className).toContain("rounded-full");
  });

  it("a team without a logo and without a sport key still renders nothing (unchanged behaviour)", () => {
    const { container } = render(<CommunityMark logoUrl={null} name="Some Team" sportKey={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Discovery rows", () => {
  it.each([
    ["Hockey", "hockey"],
    ["American Football", "american_football"],
    ["Basketball", "basketball"],
  ])("the Sports tab row for %s shows its own icon next to the name (signed in and logged out)", (name, sportKey) => {
    const signedIn = render(<ul><DiscoveryRow item={item({ displayName: name, sportKey })} /></ul>);
    expect(signedIn.container.querySelector('[data-testid="sport-icon"]')).toHaveAttribute("data-sport", sportKey);
    expect(screen.getByText(name)).toBeInTheDocument();
    signedIn.unmount();
    const publicRow = render(<ul><PublicCommunityRow item={item({ displayName: name, sportKey })} /></ul>);
    expect(publicRow.container.querySelector('[data-testid="sport-icon"]')).toHaveAttribute("data-sport", sportKey);
  });

  it("a team row keeps its crest and gets no sport icon", () => {
    const { container } = render(<ul><DiscoveryRow item={item({ type: "TEAM", displayName: "Boston Bruins", logoUrl: "https://example.test/b.png", sportKey: null })} /></ul>);
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector('[data-testid="sport-icon"]')).toBeNull();
  });
});
