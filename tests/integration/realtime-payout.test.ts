/**
 * Proves the actual live-update mechanism fires — not just the math. A
 * second Realtime client subscribes to the same channel `SocialPoolCard`
 * would, then `broadcastPoolEntryAdded` (the function `enterPoolAction`
 * calls after a successful entry) is invoked directly, and the test asserts
 * the event actually arrives with the expected payload.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { broadcastPoolEntryAdded } from "@/lib/realtime/pool-updates";
import { poolEntriesChannelName } from "@/lib/realtime/channel-names";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

describe.skipIf(!ANON_KEY || !SERVICE_ROLE_KEY)("pool entry realtime broadcast", () => {
  it("delivers an entry_added broadcast to a subscribed listener with the expected payload", async () => {
    const poolId = randomUUID();
    const listener = createSupabaseClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const received = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for broadcast")), 8000);

      const channel = listener.channel(poolEntriesChannelName(poolId));
      channel
        .on("broadcast", { event: "entry_added" }, (message) => {
          clearTimeout(timeout);
          resolve(message.payload);
        })
        .subscribe((status, err) => {
          if (status === "SUBSCRIBED") {
            broadcastPoolEntryAdded(poolId).catch((sendError) => {
              clearTimeout(timeout);
              reject(sendError);
            });
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timeout);
            reject(err ?? new Error(`subscribe failed: ${status}`));
          }
        });
    });

    const payload = await received;
    expect(payload).toEqual({ poolId });

    await listener.removeAllChannels();
  }, 10_000);

  it("does not throw when there are zero subscribers on the channel", async () => {
    await expect(broadcastPoolEntryAdded(randomUUID())).resolves.toBeUndefined();
  });
});
