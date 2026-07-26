import { describe, expect, it } from "vitest";
import { buildPoolPublishedEmail, type PoolPublishedEmailData } from "@/lib/email/resend";

const baseData: PoolPublishedEmailData = {
  question: "Who will win?",
  poolUrl: "https://brohda.com/pool/abc-123",
  locksAt: "2026-03-01T18:00:00.000Z",
  options: [],
  fixture: null,
};

describe("buildPoolPublishedEmail", () => {
  it("builds a subject and body containing the question and link", () => {
    const { subject, html } = buildPoolPublishedEmail(baseData);

    expect(subject).toBe("New pool: Who will win?");
    expect(html).toContain("Who will win?");
    expect(html).toContain('href="https://brohda.com/pool/abc-123"');
  });

  it("escapes HTML special characters in the question", () => {
    const { html, subject } = buildPoolPublishedEmail({
      ...baseData,
      question: `Will <script>alert("x")</script> & "quotes" win?`,
    });

    // The subject is plain text (never rendered as HTML), so it stays raw —
    // only the HTML body needs escaping.
    expect(subject).toContain("<script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quotes&quot;");
  });

  it("includes the lock time", () => {
    const { html } = buildPoolPublishedEmail(baseData);
    expect(html).toContain("Locks");
    expect(html).toContain("UTC");
  });

  it("renders the fixture matchup and competition badge, and uses the matchup in the subject line", () => {
    const { subject, html } = buildPoolPublishedEmail({
      ...baseData,
      fixture: {
        homeTeamName: "River Plate",
        awayTeamName: "Boca Juniors",
        homeTeamLogoUrl: null,
        awayTeamLogoUrl: null,
        competitionName: "Copa Libertadores",
        competitionLogoUrl: null,
        scheduledStartUtc: "2026-03-01T17:00:00.000Z",
      },
    });

    expect(subject).toBe("River Plate vs Boca Juniors: Who will win?");
    expect(html).toContain("River Plate");
    expect(html).toContain("Boca Juniors");
    expect(html).toContain("Copa Libertadores");
  });

  it("omits the competition line entirely when the fixture has no competition name", () => {
    const { html } = buildPoolPublishedEmail({
      ...baseData,
      fixture: {
        homeTeamName: "River Plate",
        awayTeamName: "Boca Juniors",
        homeTeamLogoUrl: null,
        awayTeamLogoUrl: null,
        competitionName: null,
        competitionLogoUrl: null,
        scheduledStartUtc: "2026-03-01T17:00:00.000Z",
      },
    });

    expect(html).not.toContain("Copa");
  });

  it("renders the competition logo when present, and omits the placeholder circle when it's not", () => {
    const withLogo = buildPoolPublishedEmail({
      ...baseData,
      fixture: {
        homeTeamName: "River Plate",
        awayTeamName: "Boca Juniors",
        homeTeamLogoUrl: null,
        awayTeamLogoUrl: null,
        competitionName: "Copa Libertadores",
        competitionLogoUrl: "https://media.api-sports.io/football/leagues/13.png",
        scheduledStartUtc: "2026-03-01T17:00:00.000Z",
      },
    }).html;
    expect(withLogo).toContain('src="https://media.api-sports.io/football/leagues/13.png"');

    // Without a competitionLogoUrl, the name should render with no image or
    // empty placeholder circle standing in for it.
    const withoutLogo = buildPoolPublishedEmail({
      ...baseData,
      fixture: {
        homeTeamName: "River Plate",
        awayTeamName: "Boca Juniors",
        homeTeamLogoUrl: null,
        awayTeamLogoUrl: null,
        competitionName: "Copa Libertadores",
        competitionLogoUrl: null,
        scheduledStartUtc: "2026-03-01T17:00:00.000Z",
      },
    }).html;
    expect(withoutLogo).toContain("Copa Libertadores");
    // The only <img> left is the header wordmark — no placeholder circle
    // stands in for the missing competition/team logos.
    expect(withoutLogo.match(/<img/g)).toHaveLength(1);
  });

  it("renders each option's label", () => {
    const { html } = buildPoolPublishedEmail({
      ...baseData,
      options: [
        { label: "River Plate", teamName: "River Plate", logoUrl: null },
        { label: "Draw", teamName: null, logoUrl: null },
        { label: "Boca Juniors", teamName: "Boca Juniors", logoUrl: null },
      ],
    });

    expect(html).toContain("River Plate");
    expect(html).toContain("Draw");
    expect(html).toContain("Boca Juniors");
  });

  it("does not include entry fee, minimum entries, or house fee", () => {
    const { html } = buildPoolPublishedEmail(baseData);
    expect(html).not.toContain("Entry fee");
    expect(html).not.toContain("Min. entries");
    expect(html).not.toContain("House fee");
  });

  it("links to the profile page (derived from the pool URL's origin) for opt-out", () => {
    const { html } = buildPoolPublishedEmail(baseData);
    expect(html).toContain('href="https://brohda.com/profile"');
  });

  it("renders the brand wordmark as a hosted image (not live text or a data URI)", () => {
    const { html } = buildPoolPublishedEmail(baseData);
    // A hosted URL, not live text (no Montserrat fallback risk) or a data:
    // URI (Gmail and others strip those, showing only the alt text).
    expect(html).toContain('src="https://brohda.com/email/brohda-logo.png"');
    expect(html).toContain('alt="brohda."');
  });
});
