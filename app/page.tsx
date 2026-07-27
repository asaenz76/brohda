import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { getLandingPageData } from "@/lib/landing/fetch";
import { LandingPage } from "@/components/landing/LandingPage";

// Marketing/beta-signup home page. Only shown while self-service
// registration is open — the whole point is to explain the product to a
// visitor who's about to create their own account. With registration
// closed (invite-only mode), a public landing page would just be
// advertising a door nobody outside the invite list can walk through, so
// "/" falls back to its original behavior: straight to /login.
export const revalidate = 60;

export default async function Home() {
  const user = await getCurrentUser();
  if (user) redirect("/feed");

  const registrationEnabled = await getRegistrationEnabled();
  if (!registrationEnabled) redirect("/login");

  const data = await getLandingPageData();
  return <LandingPage data={data} />;
}
