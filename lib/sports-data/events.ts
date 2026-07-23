import type { FixtureEventDetail } from "./types";

// API-Football's real (type, detail) string pairs from /fixtures/events,
// mapped to our internal vocabulary — mirrors status-map.ts's CODE_MAP
// pattern exactly. Application logic (lib/pools/templates/) reads only
// FixtureEventDetail, never these raw strings.
const DETAIL_MAP: Record<string, FixtureEventDetail> = {
  "goal:normal goal": "GOAL_NORMAL",
  "goal:own goal": "GOAL_OWN",
  "goal:penalty": "GOAL_PENALTY",
  "goal:missed penalty": "GOAL_PENALTY_MISSED",
  "card:yellow card": "CARD_YELLOW",
  "card:red card": "CARD_RED",
  "card:second yellow card": "CARD_SECOND_YELLOW",
};

const TYPE_MAP: Record<string, "GOAL" | "CARD" | "SUBSTITUTION" | "VAR"> = {
  goal: "GOAL",
  card: "CARD",
  subst: "SUBSTITUTION",
  var: "VAR",
};

export function normalizeEventType(rawType: string | null | undefined): "GOAL" | "CARD" | "SUBSTITUTION" | "VAR" {
  if (!rawType) return "VAR"; // unrecognized — treated conservatively, never counted as a goal/card.
  return TYPE_MAP[rawType.toLowerCase()] ?? "VAR";
}

export function normalizeEventDetail(
  rawType: string | null | undefined,
  rawDetail: string | null | undefined,
): FixtureEventDetail {
  if (!rawType || !rawDetail) return "UNKNOWN";
  const key = `${rawType.toLowerCase()}:${rawDetail.toLowerCase()}`;
  if (DETAIL_MAP[key]) return DETAIL_MAP[key];
  if (rawType.toLowerCase() === "subst") return "SUBSTITUTION";
  if (rawType.toLowerCase() === "var") return "VAR";
  return "UNKNOWN";
}
