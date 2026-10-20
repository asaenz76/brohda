/**
 * The publication date a page ITSELF states, read from its structured metadata. Used only for the publicly credited sources whose date research did not capture, so the footer can say "Source: Publisher · Date" when the date is confidently known.
 * Never a guess: the crawl or retrieval time, a date in the URL, and a "modified/updated" timestamp are not publication dates. If the page states no reliable publication date, the answer is null.
 */

const META_KEYS = new Set(["article:published_time", "og:article:published_time", "datepublished", "date", "pubdate", "publishdate", "publish-date", "publication_date", "dc.date.issued", "dcterms.created", "sailthru.date", "parsely-pub-date"]);

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
};

/** A date string from a page → an ISO timestamp, only when it is a plausible publication date (valid, not in the future, not before 2000). */
function toIso(raw: string | null | undefined, now: Date): string | null {
  const v = (raw ?? "").trim();
  if (!v || !/\d{4}/.test(v)) return null;
  const t = new Date(v).getTime();
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > now.getTime() + 24 * 3_600_000) return null;
  return new Date(t).toISOString();
}

function jsonLdDates(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === "object") {
          const o = node as Record<string, unknown>;
          if (typeof o.datePublished === "string") out.push(o.datePublished);
          Object.values(o).forEach(walk);
        }
      };
      walk(JSON.parse(m[1]));
    } catch {
      /* malformed JSON-LD is ignored */
    }
  }
  return out;
}

/** The first plausible publication date in the page's metadata, or null. Order: JSON-LD datePublished, then publication meta tags. `article:modified_time` and `dateModified` are deliberately not read. */
export function extractPublishedDate(html: string, now: Date = new Date()): string | null {
  for (const raw of jsonLdDates(html)) {
    const iso = toIso(raw, now);
    if (iso) return iso;
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop") ?? "").toLowerCase();
    if (!META_KEYS.has(key)) continue;
    const iso = toIso(attr(tag, "content"), now);
    if (iso) return iso;
  }
  return null;
}

/** Fetches a page and reads its publication date. Bounded (timeout, size), https only, and quiet on any failure (null). Called only for the one or two publicly credited sources of a finished draft. */
export async function fetchPublishedDate(url: string, fetchImpl: typeof fetch = fetch, now: Date = new Date()): Promise<string | null> {
  try {
    const u = new URL(url);
    // Only a public https hostname (no IP literal, localhost or single-label host): the URL comes from research and the caller only passes trusted-domain sources.
    if (u.protocol !== "https:" || !u.hostname.includes(".") || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":") || /(^|\.)localhost$/i.test(u.hostname)) return null;
    const res = await fetchImpl(u.toString(), { redirect: "follow", signal: AbortSignal.timeout(7000), headers: { "user-agent": "Mozilla/5.0 (compatible; BrohdaPreviewBot/1.0)", accept: "text/html,application/xhtml+xml" } });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "html")) return null;
    const html = (await res.text()).slice(0, 600_000);
    return extractPublishedDate(html, now);
  } catch {
    return null;
  }
}
