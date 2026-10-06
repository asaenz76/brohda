import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { LEGAL_DOCUMENT_ORDER, LEGAL_DOCUMENTS, type LegalAcceptanceSource, type LegalDocument } from "./documents";

/**
 * Records that a member accepted the CURRENT version of the Terms and the Privacy Policy, from `source`. Append-only in the database; a
 * second call for the same (member, document, version) is a no-op, not an error. Throws if the record could not be written — callers decide
 * what that means (registration refuses to create an account it cannot record consent for).
 */
export async function recordLegalAcceptance(userId: string, source: LegalAcceptanceSource, documents: readonly LegalDocument[] = LEGAL_DOCUMENT_ORDER): Promise<void> {
  const admin = createAdminClient();
  const rows = documents.map((document) => ({ user_id: userId, document, version: LEGAL_DOCUMENTS[document].version, source }));
  const { error } = await admin.from("legal_acceptances").upsert(rows, { onConflict: "user_id,document,version", ignoreDuplicates: true });
  if (error) throw error;
}

/** The documents whose current version this member is required to accept and hasn't — empty unless an owner switched re-consent on. */
export async function getPendingLegalAcceptances(userId: string): Promise<LegalDocument[]> {
  const admin = createAdminClient();
  const { data: settings } = await admin.from("platform_settings").select("legal_reconsent_required").eq("id", true).single();
  const required = ((settings?.legal_reconsent_required ?? []) as string[]).filter((d): d is LegalDocument => d === "terms" || d === "privacy");
  if (required.length === 0) return []; // the default: nothing is required, so no second read
  const { data: accepted } = await admin.from("legal_acceptances").select("document, version").eq("user_id", userId).in("document", required);
  const have = new Set((accepted ?? []).map((row) => `${row.document}:${row.version}`));
  return LEGAL_DOCUMENT_ORDER.filter((document) => required.includes(document) && !have.has(`${document}:${LEGAL_DOCUMENTS[document].version}`));
}
