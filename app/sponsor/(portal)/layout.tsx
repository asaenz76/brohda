import { requireSponsorAccount } from "@/lib/sponsor/session";
import { SponsorShell } from "@/components/sponsor/SponsorShell";

export const dynamic = "force-dynamic";

// Every page under the Sponsor portal: a signed-in SPONSOR account (a Member is sent to the Member product, a signed-out visitor to the Sponsor login).
export default async function SponsorPortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSponsorAccount();
  return <SponsorShell session={session}>{children}</SponsorShell>;
}
