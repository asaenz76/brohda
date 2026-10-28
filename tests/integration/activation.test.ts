/**
 * Brohda 2.1 M7 (migration 220) against the real local Supabase.
 *   - activation_funnel_summary(): the right counts and denominators for a controlled cohort (every case: activated fast, slow, never; second Pick; back after a result by Pick or by reading the notification; too young to count),
 *     only aggregates leave the database, and only the service role may call it;
 *   - getFeedItemForPost(): the same Pick state a feed card has, for one Post (and null for an unpublished one);
 *   - getAuthGameMatchup(): names a published Game for the sign-up screen, and nothing else.
 * Each funnel cohort lives in its OWN randomly chosen past month (a window no other suite or earlier run touches); rows are seeded straight into the canonical tables, trigger-free, because the point is to READ history.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedUser } from "./helpers/game-seed";
import { ensureAndPublishPostForFixture } from "@/lib/posts/publication";
import { getFeedItemForPost } from "@/lib/communities/feed";
import { getAuthGameMatchup } from "@/lib/auth/game-context";
import { getActivationFunnel } from "@/lib/activation/repository";

const admin = getTestAdminClient();
// A random month between 1980 and 2009, from the first Monday on: unique to this run, always in the past.
const YEAR = 1980 + Math.floor(Math.random() * 30);
const MONTH = Math.floor(Math.random() * 12);
const firstMonday = (() => { const d = new Date(Date.UTC(YEAR, MONTH, 1, 10, 0, 0)); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d; })();
const T0 = firstMonday.getTime();
const HOUR = 3_600_000;
const FROM = new Date(Date.UTC(YEAR, MONTH, 1)).toISOString();
const TO = new Date(Date.UTC(YEAR, MONTH + 1, 1)).toISOString();

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const pick = (userId: string, atMs: number, graded: { atMs: number } | null) => ({ id: randomUUID(), userId, marketId: randomUUID(), createdAt: iso(atMs), gradedAt: graded ? iso(graded.atMs) : null });

async function seedMember(label: string, createdMs: number, role = "player"): Promise<string> {
  const id = randomUUID();
  await withDb((c) => c.query(`insert into public.user_profiles (id, display_name, role, is_active, created_at) values ($1, $2, $3, true, $4)`, [id, `act-${label}`, role, iso(createdMs)]));
  return id;
}

async function seedPicks(rows: Array<ReturnType<typeof pick>>) {
  await withDb(async (c) => {
    for (const r of rows) {
      await c.query(
        `insert into public.predictions (id, user_id, market_id, selected_outcome, market_question_snapshot, market_status_snapshot, lifecycle_state, result, resolved_outcome_snapshot, graded_at, idempotency_key, created_at)
         values ($1, $2, $3, 'YES', 'act?', 'RESOLVED', $4, $5, $6, $7, $8, $9)`,
        [r.id, r.userId, r.marketId, r.gradedAt ? "GRADED" : "PENDING", r.gradedAt ? "CORRECT" : null, r.gradedAt ? "YES" : null, r.gradedAt, `act-${r.id}`, r.createdAt],
      );
    }
  });
}

async function seedNotification(userId: string, createdMs: number, readMs: number | null) {
  await withDb((c) => c.query(`insert into public.notifications (user_id, type, title, body, created_at, read_at) values ($1, 'prediction_graded', 'Result is in', 'x', $2, $3)`, [userId, iso(createdMs), readMs === null ? null : iso(readMs)]));
}

describe("activation_funnel_summary", () => {
  it("counts each stage with the right denominator for a controlled cohort", async () => {
    const a = await seedMember("a-fast-and-back", T0);
    const b = await seedMember("b-slow-no-return", T0);
    const c = await seedMember("c-never", T0);
    const d = await seedMember("d-back-by-notification", T0);
    const staff = await seedMember("staff", T0, "super_admin");
    const outside = await seedMember("outside-window", Date.UTC(YEAR, MONTH + 2, 1));
    void c;

    await seedPicks([
      pick(a, T0 + 10 * 60_000, { atMs: T0 + 24 * HOUR }), // first Pick 10 min after sign-up; graded a day later
      pick(a, T0 + 48 * HOUR, null), // second Pick within 7 days, and 24h after the result: "came back"
      pick(b, T0 + 30 * HOUR, { atMs: T0 + 48 * HOUR }), // first Pick 30h after sign-up (NOT within 24h); graded at +48h
      pick(d, T0 + 5 * 60_000, { atMs: T0 + 24 * HOUR }),
      pick(staff, T0 + 60_000, null),
      pick(outside, Date.UTC(YEAR, MONTH + 2, 1, 10, 5), null),
    ]);
    await seedNotification(b, T0 + 48 * HOUR, T0 + 48 * HOUR + 60 * HOUR); // read 60h after the result: too late (more than 48h)
    await seedNotification(d, T0 + 24 * HOUR, T0 + 30 * HOUR); // read 6h after the result: came back
    await withDb((cl) => cl.query(`insert into public.post_comments (id, post_id, user_id, body) values ($1, $2, $3, 'hi')`, [randomUUID(), randomUUID(), a]));

    const { data, error } = await admin.rpc("activation_funnel_summary", { p_from: FROM, p_to: TO });
    expect(error).toBeNull();
    const f = data as Record<string, unknown>;
    expect(f.registered).toBe(4); // a, b, c, d — staff and the Member outside the window are not in the cohort
    expect(f.registered_24h_old).toBe(4);
    expect(f.picked_ever).toBe(3);
    expect(f.picked_within_24h).toBe(2); // a and d
    expect(f.median_minutes_to_first_pick).toBe(10); // 5, 10, 1800
    expect(f.activated_7d_old).toBe(3);
    expect(f.second_pick_within_7d).toBe(1); // only a
    expect(f.first_graded_48h_old).toBe(3); // a, b, d (all long past 48h)
    expect(f.came_back_within_48h).toBe(2); // a (another Pick) and d (read the notification); b read it too late
    expect(f.commented).toBe(1);
    expect(f.called_bs).toBe(0);
    expect(f.by_week).toEqual([{ week: firstMonday.toISOString().slice(0, 10), registered: 4, picked_within_24h: 2 }]);

    // The application's own parser accepts exactly this, through the repository.
    const parsed = await getActivationFunnel(FROM, TO);
    expect(parsed).toMatchObject({ registered: 4, pickedWithin24h: 2, secondPickWithin7d: 1, cameBackWithin48h: 2 });
  });

  it("a Member too young to have had the chance is not counted as a failure (24h, 7d and 48h denominators)", async () => {
    const now = Date.now();
    const signedUp = now - 2 * HOUR;
    const fresh = await seedMember("fresh", signedUp);
    await seedPicks([pick(fresh, now - 90 * 60_000, { atMs: now - 30 * 60_000 })]);
    // A window of two seconds around this one Member, so nothing another suite registered can enter it.
    const { data } = await admin.rpc("activation_funnel_summary", { p_from: iso(signedUp - 1000), p_to: iso(signedUp + 1000) });
    const f = data as Record<string, unknown>;
    expect(f.registered).toBe(1);
    // Registered 2h ago: not in the 24h denominator; first Pick 90 min ago: not in the 7d denominator; first result 30 min ago: not in the 48h denominator.
    expect(f.registered_24h_old).toBe(0);
    expect(f.picked_within_24h).toBeGreaterThanOrEqual(1);
    expect(f.activated_7d_old).toBe(0);
    expect(f.first_graded_48h_old).toBe(0);
    expect(f.came_back_within_48h).toBe(0);
  });

  it("exposes aggregates only: no Member id, name, email or content", async () => {
    const { data } = await admin.rpc("activation_funnel_summary", { p_from: FROM, p_to: TO });
    const f = data as Record<string, unknown>;
    expect(Object.keys(f).sort()).toEqual(["activated_7d_old", "by_week", "called_bs", "came_back_within_48h", "commented", "first_graded_48h_old", "from", "median_minutes_to_first_pick", "picked_ever", "picked_within_24h", "ranked_this_week", "registered", "registered_24h_old", "second_pick_within_7d", "to", "weekly_min_decided"]);
    expect(JSON.stringify(f)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@|act-/i);
  });

  it("is private to the server: neither the public nor a signed-in Member can call it", async () => {
    expect((await getTestAnonClient().rpc("activation_funnel_summary", {})).error).not.toBeNull();
    const { url, anonKey } = getTestSupabaseConfig();
    const email = `act-priv-${randomUUID()}@test.local`;
    const created = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
    await admin.from("user_profiles").insert({ id: created.data.user!.id, display_name: "actpriv", role: "player", is_active: true });
    const client = createSupabaseClient(url, anonKey);
    await client.auth.signInWithPassword({ email, password: "integration-test-password-123" });
    expect((await client.rpc("activation_funnel_summary", {})).error).not.toBeNull();
    await admin.auth.admin.deleteUser(created.data.user!.id);
    expect((await admin.rpc("activation_funnel_summary", { p_from: FROM, p_to: TO })).error).toBeNull();
  });
});

describe("getFeedItemForPost and getAuthGameMatchup", () => {
  it("returns the Game as a feed card sees it — the Pick control's state included — and null for an unpublished Post", async () => {
    const viewer = await seedUser("act-viewer");
    const { fixtureId, marketId } = await seedGame({ homeName: "Act Home FC", awayName: "Act Away FC" });
    const published = await ensureAndPublishPostForFixture(fixtureId, true);
    const item = await getFeedItemForPost(published.postId, viewer);
    expect(item).not.toBeNull();
    expect(item!.homeTeamName).toBe("Act Home FC");
    expect(item!.primaryMarket).toMatchObject({ id: marketId, viewerSelection: null, isEditable: true, pickDisabledReason: null });
    expect(item!.primaryMarket!.choices.map((c) => c.outcome).sort()).toEqual(["NO", "YES"]);

    expect(await getFeedItemForPost(randomUUID(), viewer)).toBeNull();
    const { data: unpublished } = await admin.from("posts").insert({ fixture_id: (await seedGame()).fixtureId, published_at: null }).select("id").single();
    expect(await getFeedItemForPost(unpublished!.id, viewer)).toBeNull();
  });

  it("names the Game for a sign-up screen from a safe /post path, and refuses everything else", async () => {
    const { fixtureId } = await seedGame({ homeName: "Intent Home", awayName: "Intent Away" });
    const published = await ensureAndPublishPostForFixture(fixtureId, true);
    expect(await getAuthGameMatchup(`/post/${published.postId}?pick=YES`)).toMatch(/Intent (Away @ Intent Home|Home @ Intent Away|Home vs Intent Away|Away vs Intent Home)/);
    expect(await getAuthGameMatchup(`/post/${randomUUID()}`)).toBeNull();
    for (const bad of [null, "", "/feed", "//evil.com/post/x", "https://evil.com/post/x", "/post/../admin"]) expect(await getAuthGameMatchup(bad as never), String(bad)).toBeNull();
  });
});
