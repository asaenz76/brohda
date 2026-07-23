import { createBrowserClient } from "@supabase/ssr";

// Memoized: a fresh client per call means a fresh Realtime websocket per
// call too. The first caller (SocialPoolCard's live-payout subscription)
// hit this the hard way — React's dev-mode double-effect-invoke opened two
// overlapping sockets for the same channel topic and the second failed
// with CHANNEL_ERROR. One client per browser tab, reused everywhere, is
// also Supabase's own recommended pattern for the browser client.
let client: ReturnType<typeof createBrowserClient> | undefined;

export function createClient() {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return client;
}
