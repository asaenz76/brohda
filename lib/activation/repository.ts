import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseActivationFunnel } from "./format";
import type { ActivationFunnel } from "./types";

// The one read path for the activation report: ONE read-only database function on the service role (aggregates only). Who may read it is the page's job (Super Admin).
export async function getActivationFunnel(fromIso?: string, toIso?: string, client: Pick<ReturnType<typeof createAdminClient>, "rpc"> = createAdminClient()): Promise<ActivationFunnel | null> {
  const args: Record<string, string> = {};
  if (fromIso) args.p_from = fromIso;
  if (toIso) args.p_to = toIso;
  const { data, error } = await client.rpc("activation_funnel_summary", args);
  if (error) throw error;
  return parseActivationFunnel(data);
}
