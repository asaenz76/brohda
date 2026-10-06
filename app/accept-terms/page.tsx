import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { getPendingLegalAcceptances } from "@/lib/legal/acceptance";
import { LEGAL_DOCUMENT_NAMES, LEGAL_DOCUMENTS } from "@/lib/legal/documents";
import { Card, CardContent } from "@/components/ui/card";
import { AcceptLegalForm } from "./accept-form";

export const metadata: Metadata = { title: "Updated terms — brohda.", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Shown only when an owner has switched re-consent on for a document whose current version this member hasn't accepted. With nothing
// pending it simply sends them on, so a stale link or a double-submit never traps anyone.
export default async function AcceptTermsPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const user = await requireUser();
  const raw = (await searchParams).next;
  const next = sanitizeNextPath(Array.isArray(raw) ? raw[0] : raw);
  const pending = await getPendingLegalAcceptances(user.id);
  if (pending.length === 0) redirect(next ?? "/feed");

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:py-16">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <h1 className="font-heading text-xl font-semibold text-text-primary">We&apos;ve updated our {pending.map((d) => LEGAL_DOCUMENT_NAMES[d]).join(" and ")}</h1>
          <p className="text-sm text-text-secondary">Please review and accept the current version to keep using brohda.</p>
          <AcceptLegalForm
            next={next}
            documents={pending.map((key) => ({ key, name: LEGAL_DOCUMENT_NAMES[key], effectiveDate: LEGAL_DOCUMENTS[key].effectiveDate }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
