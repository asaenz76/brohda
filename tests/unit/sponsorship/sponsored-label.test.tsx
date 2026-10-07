import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SponsoredLabel } from "@/components/sponsorship/SponsoredLabel";
import { PROMOTION_DISCLOSURE, SponsorPromotion } from "@/components/sponsorship/SponsorPromotion";
import type { PublicSponsorship } from "@/lib/sponsorship/types";

const sponsorship = (o: Partial<PublicSponsorship> = {}): PublicSponsorship => ({ id: "11111111-1111-4111-8111-111111111111", presentedBy: "Acme Sports", tagline: null, ctaText: "Learn more", logoUrl: "https://x.supabase.co/storage/v1/object/public/sponsor-logos/a/b.webp", promotion: null, ...o });

type IOCallback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
let observers: Array<{ cb: IOCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

beforeEach(() => {
  vi.useFakeTimers();
  observers = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      disconnect = vi.fn();
      constructor(cb: IOCallback) {
        observers.push({ cb, disconnect: this.disconnect });
      }
      observe() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const see = (ratio: number) => act(() => observers.at(-1)!.cb([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]));

describe("SponsoredLabel", () => {
  it("says 'Sponsored' and 'Presented by <name>' in readable text — the logo is only decoration", () => {
    const { container } = render(<SponsoredLabel sponsorship={sponsorship()} trackImpression={false} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Sponsored");
    expect(text).toContain("Presented by");
    expect(text).toContain("Acme Sports");
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("the call to action is a first-party redirect link: new tab, sponsored + noopener, with a descriptive accessible name", () => {
    render(<SponsoredLabel sponsorship={sponsorship()} trackImpression={false} />);
    const link = screen.getByRole("link", { name: /Learn more — opens Acme Sports's website in a new tab/ });
    expect(link).toHaveAttribute("href", "/sponsorship/click/11111111-1111-4111-8111-111111111111");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("sponsored");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("href")).not.toMatch(/^https?:/); // never the sponsor's own URL in the page
  });

  it("no call to action → no link; no logo → just the name", () => {
    const { container } = render(<SponsoredLabel sponsorship={sponsorship({ ctaText: null, logoUrl: null })} trackImpression={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Presented by Acme Sports");
  });

  it("impressions: not tracked unless asked (public visitors are never recorded)", () => {
    render(<SponsoredLabel sponsorship={sponsorship()} trackImpression={false} />);
    expect(observers).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an impression needs at least half visible for a full second — then it is reported exactly once, however much it scrolls or re-renders", () => {
    const { rerender } = render(<SponsoredLabel sponsorship={sponsorship()} trackImpression />);
    see(0.3);
    vi.advanceTimersByTime(2000);
    expect(fetchMock).not.toHaveBeenCalled(); // under half: no
    see(0.6);
    vi.advanceTimersByTime(900);
    expect(fetchMock).not.toHaveBeenCalled(); // not yet a second
    see(0);
    vi.advanceTimersByTime(2000);
    expect(fetchMock).not.toHaveBeenCalled(); // scrolled away before a second: no
    see(0.9);
    vi.advanceTimersByTime(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sponsorship/impression");
    expect(JSON.parse(String(init.body))).toEqual({ sponsorshipId: "11111111-1111-4111-8111-111111111111" });
    see(0);
    see(1);
    vi.advanceTimersByTime(3000);
    rerender(<SponsoredLabel sponsorship={sponsorship()} trackImpression />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a broken logo disappears instead of showing a broken image", () => {
    const { container } = render(<SponsoredLabel sponsorship={sponsorship()} trackImpression={false} />);
    const img = container.querySelector("img")!;
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Acme Sports");
  });
});

describe("SponsorPromotion", () => {
  const promotion = { title: "Win season tickets", description: "Enter on our site.", prizeDescription: "Two tickets", officialRulesUrl: "https://acme.example.com/rules", fulfillmentName: "Acme Promotions LLC", eligibilitySummary: "18+" };

  it("shows the approved metadata, who runs it, a rules link, and the disclosure that Brohda does not run it", () => {
    const { container } = render(<SponsorPromotion promotion={promotion} />);
    expect(container.textContent).toContain("Win season tickets");
    expect(container.textContent).toContain("Run by Acme Promotions LLC");
    expect(container.textContent).toContain(PROMOTION_DISCLOSURE);
    const rules = screen.getByRole("link", { name: "Official rules" });
    expect(rules).toHaveAttribute("href", "https://acme.example.com/rules");
    expect(rules.getAttribute("rel")).toContain("noopener");
  });

  it("offers no entry, claim, draw or winner affordance of any kind", () => {
    render(<SponsorPromotion promotion={promotion} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b(enter now|claim|you won|winner announced|draw)\b/i);
  });
});
