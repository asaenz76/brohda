import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export interface SponsorshipConfig {
  defaultCurrency: string;
  logoMaxBytes: number;
  endAfterKickoffHours: number;
  paymentInstructions: string;
}

/**
 * The sponsorship configuration read from platform_settings (the capability itself is read by isSponsorshipEnabled — fail closed). Every value has its one
 * default in the database; if the settings cannot be read this THROWS rather than inventing a second copy of a limit or a currency in code.
 */
export async function getSponsorshipConfig(): Promise<SponsorshipConfig> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("platform_settings").select("sponsorship_default_currency, sponsorship_logo_max_bytes, sponsorship_end_after_kickoff_hours, sponsorship_payment_instructions").eq("id", true).single();
  if (error || !data) throw new Error("Could not read the sponsorship settings.");
  return {
    defaultCurrency: data.sponsorship_default_currency,
    logoMaxBytes: data.sponsorship_logo_max_bytes,
    endAfterKickoffHours: data.sponsorship_end_after_kickoff_hours,
    paymentInstructions: data.sponsorship_payment_instructions,
  };
}
