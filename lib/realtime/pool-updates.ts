import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { poolEntriesChannelName } from "./channel-names";

/**
 * Pings every viewer currently looking at this pool that an entry just
 * landed, so their percentages/payout estimates can refresh without a
 * reload. Uses `httpSend` — a single REST POST with no websocket handshake
 * (@supabase/realtime-js >= 2.37.0) — since this is a one-off send, not a
 * persistent subscription. Awaited by the caller (not fire-and-forget):
 * this runs inside a serverless server action, which can freeze/tear down
 * immediately after the response returns, so an un-awaited send could be
 * silently dropped far more often than an ordinary network blip.
 */
export async function broadcastPoolEntryAdded(poolId: string): Promise<void> {
  const admin = createAdminClient();
  const channel = admin.channel(poolEntriesChannelName(poolId));
  try {
    await channel.httpSend("entry_added", { poolId });
  } finally {
    await admin.removeChannel(channel);
  }
}
