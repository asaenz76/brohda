import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkoutOffered } from "./config";
import { getAdapter } from "./registry";
import type { CommercialPaymentProvider, ProviderAvailability } from "./types";

// The ONLINE PAYMENT POLICY for new sponsorship payments: a business setting (on/off + which registered provider), read from platform_settings on every request — so a Super
// Admin's change applies immediately, with no deploy, no migration and no cache to wait for. Availability needs BOTH the policy AND the provider's own runtime configuration
// (its secrets, in the hosting environment): the setting alone never makes anything usable, and nothing ever silently falls back to a different provider.
export interface OnlinePaymentPolicy {
  enabled: boolean;
  providerKey: string | null;
}

export type OnlinePaymentState =
  | { state: "disabled" }
  | { state: "unavailable"; providerKey: string | null; reason: string }
  | { state: "available"; providerKey: string; label: string; environment: "TEST" | "LIVE"; offered: boolean };

export async function getOnlinePaymentPolicy(): Promise<OnlinePaymentPolicy> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("platform_settings").select("sponsorship_online_payments_enabled, sponsorship_online_payment_provider").eq("id", true).single();
  if (error || !data) return { enabled: false, providerKey: null }; // unreadable → off (fail closed)
  return { enabled: data.sponsorship_online_payments_enabled === true, providerKey: data.sponsorship_online_payment_provider ?? null };
}

/** What a Sponsor-facing page / the payment service may do right now for NEW payments. */
export async function resolveOnlinePayment(env: Record<string, string | undefined> = process.env): Promise<OnlinePaymentState & { adapter?: CommercialPaymentProvider }> {
  const policy = await getOnlinePaymentPolicy();
  if (!policy.enabled) return { state: "disabled" };
  if (!policy.providerKey) return { state: "unavailable", providerKey: null, reason: "No provider is selected." };
  const adapter = getAdapter(policy.providerKey);
  if (!adapter) return { state: "unavailable", providerKey: policy.providerKey, reason: "The selected provider isn't installed in this deployment." };
  if (!adapter.capabilities.supportsCheckout) return { state: "unavailable", providerKey: policy.providerKey, reason: "The selected provider can't take payments." };
  const availability: ProviderAvailability = adapter.availability();
  if (availability.state === "unavailable") return { state: "unavailable", providerKey: policy.providerKey, reason: availability.reason };
  return { state: "available", providerKey: adapter.key, label: adapter.label, environment: availability.environment, offered: checkoutOffered(availability, env), adapter };
}
