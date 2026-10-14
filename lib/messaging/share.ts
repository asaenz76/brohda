import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatMatchup } from "@/lib/sports-data/team-display-order";
import { getChoicePresentation, getSelectionLabel, type SelectionLabelSource } from "@/lib/prediction-markets/selection-labels";
import type { MarketTemplate } from "@/lib/prediction-markets/types";

// Sharing a Brohda object in a message. The CANONICAL object stays the source of truth: a message stores only (type, id) — never a copy of the object — so a changed or removed object is simply
// rendered as it is now, and an unavailable one fails gracefully. Nothing here widens access:
//   POST / MARKET   anything a Member can already open (a published Post; a Market). The card links to the ordinary page, which enforces its own access gate.
//   PICK            ONLY the sender's own Pick, shown as an explicit disclosure the sender chose to make: the Game, the Market, the side picked and — once graded — the result. Nothing else about it
//                   (no timing, no account data) and, by design of the product, there is no Confidence or money attached to a Pick at this stage.
//   CALL_BS         ONLY a Call BS the sender is in. The other participant sees it in full; anyone else sees it only once it is RESOLVED, which is exactly the existing public-record rule.
// Rendering is always done on the server, per viewer, so the same message can read differently to different people without ever leaking the private version.

export type ShareType = "POST" | "MARKET" | "PICK" | "CALL_BS";
export interface ShareTarget {
  type: ShareType;
  ref: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Recognises a Brohda Post or Market link pasted into the share box. Only the path matters; the id is validated against the database anyway. */
export function parseBrohdaLink(input: string): ShareTarget | null {
  const trimmed = input.trim();
  let path = trimmed;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    // not an absolute URL: treat the input as a path
  }
  const match = /^\/(post|markets)\/([0-9a-f-]{36})\/?$/i.exec(path);
  if (!match || !isUuid(match[2])) return null;
  return { type: match[1].toLowerCase() === "post" ? "POST" : "MARKET", ref: match[2].toLowerCase() };
}

/** May THIS sender share THIS object? Re-checked on the server at send time; the client's choice is never trusted. */
export async function senderMayShare(userId: string, target: ShareTarget): Promise<boolean> {
  if (!isUuid(target.ref)) return false;
  const admin = createAdminClient();
  switch (target.type) {
    case "POST": {
      const { data } = await admin.from("posts").select("id").eq("id", target.ref).not("published_at", "is", null).maybeSingle();
      return Boolean(data);
    }
    case "MARKET": {
      const { data } = await admin.from("markets").select("id, fixture_id").eq("id", target.ref).maybeSingle();
      return Boolean(data?.fixture_id);
    }
    case "PICK": {
      const { data } = await admin.from("predictions").select("id").eq("id", target.ref).eq("user_id", userId).maybeSingle();
      return Boolean(data);
    }
    case "CALL_BS": {
      const { data } = await admin.from("challenges").select("id").eq("id", target.ref).or(`challenger_user_id.eq.${userId},recipient_user_id.eq.${userId}`).maybeSingle();
      return Boolean(data);
    }
  }
}

export type SharedObjectView =
  | { state: "unavailable" }
  | { state: "ok"; type: ShareType; label: string; title: string; detail: string | null; href: string | null };

interface FixtureLite {
  sport: string;
  home_team_name: string | null;
  away_team_name: string | null;
  competition_name: string | null;
}

const unavailable: SharedObjectView = { state: "unavailable" };

function gameTitle(f: FixtureLite): string {
  return f.home_team_name && f.away_team_name ? formatMatchup(f.sport, f.home_team_name, f.away_team_name) : "A Game";
}

interface MarketRow {
  id: string;
  fixture_id: string;
  market_template: MarketTemplate | null;
  line_value: number | null;
  yes_side: "HOME" | "AWAY" | null;
  fixtures: FixtureLite | FixtureLite[] | null;
}

interface PickRow {
  id: string;
  selected_outcome: "YES" | "NO";
  result: string | null;
  market_id: string;
}

interface CallBsRow {
  id: string;
  status: string;
  result: string | null;
  challenger_user_id: string;
  recipient_user_id: string;
  challenger_selection_snapshot: "YES" | "NO";
  recipient_selection_snapshot: "YES" | "NO";
  market_id: string;
}

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

function labelSource(m: MarketRow, f: FixtureLite): SelectionLabelSource {
  return { marketTemplate: m.market_template, lineValue: m.line_value, yesSide: m.yes_side, homeTeamName: f.home_team_name, awayTeamName: f.away_team_name, sport: f.sport };
}

async function loadMarket(marketId: string): Promise<{ market: MarketRow; fixture: FixtureLite } | null> {
  const { data } = await createAdminClient().from("markets").select(MARKET_SELECT).eq("id", marketId).maybeSingle();
  const market = data as unknown as MarketRow | null;
  const fixture = market ? one(market.fixtures) : null;
  return market && fixture ? { market, fixture } : null;
}

async function postIdForFixture(fixtureId: string): Promise<string | null> {
  const { data } = await createAdminClient().from("posts").select("id").eq("fixture_id", fixtureId).not("published_at", "is", null).limit(1).maybeSingle();
  return data?.id ?? null;
}

// Plain `string` constants (not literals): the select strings are built from shared parts, so the query result is deliberately untyped here and narrowed by the row interfaces above.
const MARKET_FIELDS: string = "fixture_id, market_template, line_value, yes_side, fixtures(sport, home_team_name, away_team_name, competition_name)";
const MARKET_SELECT: string = `id, ${MARKET_FIELDS}`;
// predictions and challenges carry a market_id but no foreign key to markets, so the Market is always loaded by its own query (loadMarket), never as an embedded join.
const PICK_SELECT: string = "id, user_id, selected_outcome, result, market_id";
const CALL_BS_SELECT: string = "id, status, result, challenger_user_id, recipient_user_id, challenger_selection_snapshot, recipient_selection_snapshot, market_id";

/** What the VIEWER may see for one shared object. Never throws: any problem is "unavailable". */
export async function resolveSharedObject(viewerId: string, senderId: string | null, target: ShareTarget): Promise<SharedObjectView> {
  try {
    if (!isUuid(target.ref)) return unavailable;
    const admin = createAdminClient();

    if (target.type === "POST") {
      const { data } = await admin.from("posts").select("id, fixtures(sport, home_team_name, away_team_name, competition_name)").eq("id", target.ref).not("published_at", "is", null).maybeSingle();
      const f = one(data?.fixtures as FixtureLite | FixtureLite[] | null);
      if (!data || !f) return unavailable;
      return { state: "ok", type: "POST", label: "Game", title: gameTitle(f), detail: f.competition_name, href: `/post/${data.id}` };
    }

    if (target.type === "MARKET") {
      const { data } = await admin.from("markets").select(MARKET_SELECT).eq("id", target.ref).maybeSingle();
      const m = data as unknown as MarketRow | null;
      const f = m ? one(m.fixtures) : null;
      if (!m || !f) return unavailable;
      const market = getChoicePresentation(labelSource(m, f)).marketLabel;
      return { state: "ok", type: "MARKET", label: "Market", title: gameTitle(f), detail: market, href: `/markets/${m.id}` };
    }

    if (target.type === "PICK") {
      if (!senderId) return unavailable;
      const { data: pickData } = await admin.from("predictions").select(PICK_SELECT).eq("id", target.ref).eq("user_id", senderId).maybeSingle();
      const data = pickData as unknown as PickRow | null;
      if (!data) return unavailable;
      const loaded = await loadMarket(data.market_id);
      if (!loaded) return unavailable;
      const { market: m, fixture: f } = loaded;
      const source = labelSource(m, f);
      const side = getSelectionLabel(source, data.selected_outcome as "YES" | "NO");
      const marketLabel = getChoicePresentation(source).marketLabel;
      const result = data.result === "CORRECT" ? "Correct" : data.result === "INCORRECT" ? "Incorrect" : data.result === "VOID" ? "Void" : null;
      const postId = await postIdForFixture(m.fixture_id);
      return { state: "ok", type: "PICK", label: "Pick", title: side, detail: [gameTitle(f), marketLabel, result].filter(Boolean).join(" · "), href: postId ? `/post/${postId}` : `/markets/${data.market_id}` };
    }

    // CALL_BS: a participant sees it fully; anyone else only once it is a resolved (public) record.
    const { data: callBsData } = await admin
      .from("challenges")
      .select(CALL_BS_SELECT)
      .eq("id", target.ref)
      .maybeSingle();
    const data = callBsData as unknown as CallBsRow | null;
    if (!data) return unavailable;
    const participant = data.challenger_user_id === viewerId || data.recipient_user_id === viewerId;
    if (!participant && data.status !== "RESOLVED") return unavailable;
    const loaded = await loadMarket(data.market_id);
    if (!loaded) return unavailable;
    const { market: m, fixture: f } = loaded;
    const source = labelSource(m, f);
    const a = getSelectionLabel(source, data.challenger_selection_snapshot as "YES" | "NO");
    const b = getSelectionLabel(source, data.recipient_selection_snapshot as "YES" | "NO");
    const outcome =
      data.status === "RESOLVED" ? (data.result === "VOID" ? "Void" : data.result === "CHALLENGER_WON" ? `${a} was right` : `${b} was right`) : data.status === "ACCEPTED" ? "Accepted" : data.status === "PENDING" ? "Waiting for an answer" : null;
    const postId = await postIdForFixture(m.fixture_id);
    return { state: "ok", type: "CALL_BS", label: "Call BS", title: `${a} vs ${b}`, detail: [gameTitle(f), outcome].filter(Boolean).join(" · "), href: postId ? `/post/${postId}` : `/markets/${data.market_id}` };
  } catch {
    return unavailable;
  }
}
