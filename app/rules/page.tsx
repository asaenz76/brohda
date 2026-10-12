import type { Metadata } from "next";
import { BookOpen } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { getRulesPolicy } from "@/lib/rules/policy";
import { rulesMetaDescription } from "@/lib/rules/format";
import { loadLegalMoneyMode } from "@/lib/legal/money-mode-loader";
import { showsMemberMoney } from "@/lib/legal/money-mode";
import { RulesContent } from "@/components/rules/RulesContent";
import { AuthenticatedPage } from "@/components/shell/AuthenticatedPage";
import { PublicPageFrame } from "@/components/shell/PublicPageFrame";
import { publicAccountNav } from "@/components/shell/PublicAccountNav";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

// The description follows the same decision as the page body (lib/legal/money-mode.ts): it only mentions money while Member money is shown, so the <meta> text can
// never describe a feature the page itself hides.
export async function generateMetadata(): Promise<Metadata> {
  const money = showsMemberMoney(await loadLegalMoneyMode());
  return {
    title: "Brohda Rules",
    description: rulesMetaDescription(money),
  };
}

// Read live on every request: the cutoff, fee and stake limits quoted on the
// page come from the platform settings, and a prerendered copy would go stale.
export const dynamic = "force-dynamic";

// One page, one source of truth (RulesContent), two frames: signed-out
// visitors read it in the public frame, signed-in members inside the app
// shell. No account is required, and nothing on it mutates anything.
export default async function RulesPage() {
  const [user, policy] = await Promise.all([getCurrentUser(), getRulesPolicy()]);

  if (user) {
    return (
      <AuthenticatedPage user={user}>
        <div className="space-y-3">
          <ColumnHeader title="Rules" icon={BookOpen} />
          <article className="mx-auto max-w-[640px] px-1 pt-2 pb-4">
            <RulesContent policy={policy} />
          </article>
        </div>
      </AuthenticatedPage>
    );
  }

  return (
    <PublicPageFrame accountNav={await publicAccountNav()}>
      <article className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Brohda Rules</h1>
        <RulesContent policy={policy} />
      </article>
    </PublicPageFrame>
  );
}
