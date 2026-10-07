import type { Metadata } from "next";
import { TermsDocument } from "@/components/legal/TermsDocument";
import { loadLegalMoneyMode } from "@/lib/legal/money-mode-loader";

export const metadata: Metadata = {
  title: "Terms of Service — brohda.",
  robots: { index: false, follow: false },
};

// Read per request: what the Terms say about the optional money layer follows the canonical consumer money capability (and the facts about
// retained financial records), exactly as the Rules page does — see lib/legal/money-mode.ts. The document is composed in TermsDocument.
export const dynamic = "force-dynamic";

export default async function TermsPage() {
  return <TermsDocument mode={await loadLegalMoneyMode()} />;
}
