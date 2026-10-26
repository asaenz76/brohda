// Brohda 2.1 M3 — evidence normalisation. Turns what research providers return into the audited evidence set a story may rest on.
//
// Responsibilities (all deterministic, none delegated to a model):
//   * classify every source with the central policy and exclude blocked ones (reason recorded);
//   * sanitise text and QUARANTINE anything that reads like an instruction to the system (prompt-injection resistance): retrieved pages are data, never commands;
//   * de-duplicate (same page + same fact), cap the number of sources, never keep an unbounded set;
//   * resolve contradictions between sources about the same fact — newer-and-at-least-as-authoritative wins, otherwise the fact is CONFLICTED and unusable. A better story is never a reason to choose a side.
import { canonicalUrl, classifySource, hostOf, minAuthorityForClaim } from "./source-policy";
import { looksLikeInjection, normalizeForCompare, sanitizeText } from "./text";
import type { EvidenceItem, GameContext, RawEvidence, StoryConfig } from "./types";

/** Facts one page may contribute, and the authority a page needs for its facts to support a high-risk claim. */
const MAX_FACTS_PER_PAGE = 6;
const HIGH_RISK_FLOOR = minAuthorityForClaim("AVAILABILITY");

export interface NormalizeStats {
  received: number;
  usable: number;
  blocked: number;
  suspicious: number;
  duplicates: number;
  overLimit: number;
  superseded: number;
  conflicted: number;
}

const validIso = (value: string | null, now: Date, allowFutureDays = 1): string | null => {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  if (t > now.getTime() + allowFutureDays * 86_400_000) return null;
  return new Date(t).toISOString();
};

export function normalizeEvidence(
  raw: readonly RawEvidence[],
  game: Pick<GameContext, "homeTeam" | "awayTeam">,
  config: Pick<StoryConfig, "preferredDomains" | "blockedDomains" | "maxSources">,
  now: Date,
  newId: () => string,
): { items: EvidenceItem[]; stats: NormalizeStats } {
  const stats: NormalizeStats = { received: raw.length, usable: 0, blocked: 0, suspicious: 0, duplicates: 0, overLimit: 0, superseded: 0, conflicted: 0 };
  const seen = new Set<string>();
  const items: EvidenceItem[] = [];

  for (const r of raw) {
    const factText = sanitizeText(r.factText ?? "", 600);
    if (!factText) continue;
    const cls = classifySource(r.url, game, config);
    const excerpt = r.excerpt ? sanitizeText(r.excerpt, 400) : null;
    const title = r.title ? sanitizeText(r.title, 400) : null;
    const publisher = sanitizeText(r.publisher ?? hostOf(r.url) ?? "Unknown", 200) || "Unknown";
    const canonicalId = cls.reason === "no_valid_url" ? sanitizeText(r.url ?? "", 600) || "invalid" : canonicalUrl(r.url);
    const base: EvidenceItem = {
      id: newId(),
      kind: cls.kind,
      authority: cls.authority,
      canonicalId,
      url: cls.reason === "no_valid_url" ? null : r.url.slice(0, 600),
      publisher,
      title,
      publishedAt: validIso(r.publishedAt, now),
      retrievedAt: now.toISOString(),
      evidenceType: r.evidenceType,
      factKey: r.factKey ? sanitizeText(r.factKey, 200).toLowerCase() : null,
      factValue: r.factValue ? sanitizeText(r.factValue, 100).toUpperCase() : null,
      subjectTeam: r.subjectTeam,
      factText,
      excerpt,
      asOf: validIso(r.asOf, now, 0),
      status: "USABLE",
      statusReason: null,
    };
    if (cls.blocked) {
      stats.blocked++;
      items.push({ ...base, status: "DROPPED", statusReason: cls.reason });
      continue;
    }
    if ([factText, excerpt ?? "", title ?? "", publisher].some(looksLikeInjection)) {
      stats.suspicious++;
      items.push({ ...base, status: "SUSPICIOUS", statusReason: "text_reads_like_an_instruction" });
      continue;
    }
    const dupKey = `${canonicalId}|${normalizeForCompare(factText)}`;
    if (seen.has(dupKey)) {
      stats.duplicates++;
      items.push({ ...base, status: "DROPPED", statusReason: "duplicate" });
      continue;
    }
    seen.add(dupKey);
    items.push(base);
  }

  // The cap counts distinct PAGES (sources), not facts: one article can carry many facts. Pages are ranked strong-and-dated first — a page whose facts can support a high-risk claim (authority >= the floor) and that states a
  // date outranks a stronger-sounding undated one, then by authority, then by recency — and every fact of a kept page stays (up to a per-page and a total ceiling so a single page cannot flood the set).
  const usable = items.filter((i) => i.status === "USABLE");
  const pages = new Map<string, EvidenceItem[]>();
  for (const i of usable) pages.set(i.canonicalId, [...(pages.get(i.canonicalId) ?? []), i]);
  const stamp = (p: EvidenceItem[]) => Math.max(...p.map((i) => Date.parse(i.publishedAt ?? "") || 0));
  const rank = (p: EvidenceItem[]) => [Math.max(...p.map((i) => i.authority)) >= HIGH_RISK_FLOOR && stamp(p) > 0 ? 1 : 0, Math.max(...p.map((i) => i.authority)), stamp(p)];
  const ordered = [...pages.values()].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2];
  });
  const maxPages = Math.max(config.maxSources, 1);
  let kept = 0;
  ordered.forEach((page, index) => {
    for (const [n, item] of page.entries()) {
      if (index >= maxPages) { item.status = "DROPPED"; item.statusReason = "over_source_limit"; stats.overLimit++; }
      else if (n >= MAX_FACTS_PER_PAGE || kept >= maxPages * MAX_FACTS_PER_PAGE) { item.status = "DROPPED"; item.statusReason = "over_fact_limit"; stats.overLimit++; }
      else kept++;
    }
  });

  const conflicts = resolveConflicts(items);
  stats.superseded = conflicts.superseded;
  stats.conflicted = conflicts.conflicted;
  stats.usable = items.filter((i) => i.status === "USABLE").length;
  return { items, stats };
}

/** Structured-data items are built by Brohda itself and need no source classification; they only go through de-duplication, the cap and conflict resolution with web evidence. */
export function mergeStructured(structured: readonly EvidenceItem[], web: readonly EvidenceItem[]): EvidenceItem[] {
  const items = [...structured.map((s) => ({ ...s })), ...web];
  resolveConflicts(items);
  return items;
}

/**
 * Items about the same fact (same factKey) with DIFFERENT values contradict each other.
 *   * the newest dated item wins only if its authority is not materially below every older item's (within 15 points) — then older ones are SUPERSEDED;
 *   * if the newest is much weaker than an older one, or dates are equal/missing, no side is chosen: every item of the group is CONFLICTED and cannot support a claim.
 * Items without a factKey or value are never in conflict.
 */
export function resolveConflicts(items: EvidenceItem[]): { superseded: number; conflicted: number } {
  let superseded = 0;
  let conflicted = 0;
  const groups = new Map<string, EvidenceItem[]>();
  for (const i of items) {
    if (i.status !== "USABLE" || !i.factKey || !i.factValue) continue;
    const g = groups.get(i.factKey) ?? [];
    g.push(i);
    groups.set(i.factKey, g);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((i) => i.factValue)).size < 2) continue;
    const dated = [...group].sort((a, b) => (Date.parse(b.publishedAt ?? b.asOf ?? "") || 0) - (Date.parse(a.publishedAt ?? a.asOf ?? "") || 0));
    const newest = dated[0];
    const newestT = Date.parse(newest.publishedAt ?? newest.asOf ?? "") || 0;
    const others = dated.slice(1);
    const sameInstant = others.some((o) => (Date.parse(o.publishedAt ?? o.asOf ?? "") || 0) === newestT);
    const strongestOlder = Math.max(...others.map((o) => o.authority));
    if (newestT > 0 && !sameInstant && newest.authority >= strongestOlder - 15) {
      for (const o of others) {
        if (o.factValue !== newest.factValue) {
          o.status = "SUPERSEDED";
          o.statusReason = "a_newer_source_reports_a_different_value";
          superseded++;
        }
      }
    } else {
      for (const i of group) {
        i.status = "CONFLICTED";
        i.statusReason = "credible_sources_disagree";
        conflicted++;
      }
    }
  }
  return { superseded, conflicted };
}
