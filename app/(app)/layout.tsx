import { requireUser } from "@/lib/auth/session";
import { AuthenticatedPage } from "@/components/shell/AuthenticatedPage";

export default async function AppRouteLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return <AuthenticatedPage user={user}>{children}</AuthenticatedPage>;
}
