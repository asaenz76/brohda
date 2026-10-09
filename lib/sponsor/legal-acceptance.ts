import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { CURRENT_SPONSOR_TERMS, SPONSOR_TERMS_KEY, type SponsorLegalDocument } from "./terms";

// Recording and checking acceptance of the Sponsor Terms. The VERSION is always taken from the registry on the server — never from the client — and
// every acceptance is an append-only row (account, sponsor, document, exact version, time, source). There is no mutable "accepted" flag anywhere.
export type SponsorTermsSource = "signup" | "reconsent";

/** Records that this Sponsor account accepted `doc`'s current version. A repeat for the same version is a no-op. Throws if it cannot be written. */
export async function recordSponsorTermsAcceptance(userId: string, sponsorId: string, source: SponsorTermsSource, doc: SponsorLegalDocument | null = CURRENT_SPONSOR_TERMS): Promise<void> {
  if (!doc) return; // nothing approved, nothing to accept
  const admin = createAdminClient();
  const { error } = await admin
    .from("sponsor_terms_acceptances")
    .upsert({ user_id: userId, sponsor_id: sponsorId, document_key: doc.key, version: doc.version, source }, { onConflict: "user_id,document_key,version", ignoreDuplicates: true });
  if (error) throw error;
}

/** True when no approved Sponsor Terms exist, or this account has accepted the current version. */
export async function hasAcceptedCurrentSponsorTerms(userId: string, doc: SponsorLegalDocument | null = CURRENT_SPONSOR_TERMS): Promise<boolean> {
  if (!doc) return true;
  const admin = createAdminClient();
  const { data } = await admin.from("sponsor_terms_acceptances").select("id").eq("user_id", userId).eq("document_key", doc.key ?? SPONSOR_TERMS_KEY).eq("version", doc.version).limit(1);
  return (data ?? []).length > 0;
}
