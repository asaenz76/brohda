import { describe, expect, it, vi } from "vitest";
import { extractPublishedDate, fetchPublishedDate } from "@/lib/game-previews/source-dates";

const NOW = new Date("2026-10-20T16:00:00.000Z");
const page = (head: string) => `<html><head>${head}</head><body><h1>Story</h1></body></html>`;

describe("(tests L, M) publication date comes only from what the page states", () => {
  it("L: reads the date the page states: JSON-LD datePublished, then publication meta tags", () => {
    expect(extractPublishedDate(page('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-20T11:02:00-04:00","dateModified":"2026-10-20T15:00:00Z"}</script>'), NOW)).toBe("2026-10-20T15:02:00.000Z");
    expect(extractPublishedDate(page('<meta property="article:published_time" content="2026-09-22T17:56:00Z">'), NOW)).toBe("2026-09-22T17:56:00.000Z");
    expect(extractPublishedDate(page('<meta name="date" content="2026-10-19">'), NOW)).toBe("2026-10-19T00:00:00.000Z");
    expect(extractPublishedDate(page('<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"NewsArticle","datePublished":"2026-10-19T13:28:00-04:00"}]}</script>'), NOW)).toBe("2026-10-19T17:28:00.000Z");
  });
  it("M: no stated publication date is null: a modified/updated time, a date in the URL or a future/garbage value is never used", () => {
    expect(extractPublishedDate(page('<meta property="article:modified_time" content="2026-10-20T10:00:00Z">'), NOW)).toBeNull();
    expect(extractPublishedDate(page('<script type="application/ld+json">{"dateModified":"2026-10-20T10:00:00Z"}</script>'), NOW)).toBeNull();
    expect(extractPublishedDate(page('<meta property="article:published_time" content="not a date">'), NOW)).toBeNull();
    expect(extractPublishedDate(page('<meta property="article:published_time" content="2031-01-01T00:00:00Z">'), NOW)).toBeNull();
    expect(extractPublishedDate("<html><body>Published yesterday</body></html>", NOW)).toBeNull();
    expect(extractPublishedDate(page('<script type="application/ld+json">{broken</script>'), NOW)).toBeNull();
  });
  it("fetchPublishedDate reads a page, and is quiet (null) for a failure, a non-HTML answer, a non-https or non-public address", async () => {
    const ok = vi.fn(async () => new Response(page('<meta property="article:published_time" content="2026-10-20T08:00:00Z">'), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(await fetchPublishedDate("https://www.nhl.com/devils/news/preview-1", ok as unknown as typeof fetch, NOW)).toBe("2026-10-20T08:00:00.000Z");
    const notFound = vi.fn(async () => new Response("no", { status: 404 }));
    expect(await fetchPublishedDate("https://www.nhl.com/x", notFound as unknown as typeof fetch, NOW)).toBeNull();
    const boom = vi.fn(async () => { throw new Error("network"); });
    expect(await fetchPublishedDate("https://www.nhl.com/x", boom as unknown as typeof fetch, NOW)).toBeNull();
    for (const bad of ["http://www.nhl.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://intranet/x"]) expect(await fetchPublishedDate(bad, ok as unknown as typeof fetch, NOW)).toBeNull();
  });
});
