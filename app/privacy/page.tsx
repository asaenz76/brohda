import type { Metadata } from "next";
import { PrivacyDocument } from "@/components/legal/PrivacyDocument";
import { loadLegalMoneyMode } from "@/lib/legal/money-mode-loader";

export const metadata: Metadata = {
  title: "Privacy Policy — brohda.",
  robots: { index: false, follow: false },
};

// Read per request, like the Terms and the Rules: the current-feature money explanations follow the canonical consumer money capability, while
// the disclosure of financial records Brohda still holds follows the facts (lib/legal/money-mode.ts). The document is composed in PrivacyDocument.
export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  return <PrivacyDocument mode={await loadLegalMoneyMode()} />;
}
