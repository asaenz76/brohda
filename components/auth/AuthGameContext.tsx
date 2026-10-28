import { getAuthGameMatchup } from "@/lib/auth/game-context";

/**
 * M7 — a visitor who tapped a side on a Game and was sent to sign up or log in should still see WHY: the Game they came for. One short line, no tutorial. The side they tapped is carried in the address as a hint and
 * confirmed explicitly on the Game afterwards (nothing is saved before that), so it is not repeated here.
 */
export async function AuthGameContext({ next, action }: { next: string | null; action: "create" | "login" }) {
  const matchup = await getAuthGameMatchup(next);
  if (!matchup) return null;
  return (
    <div className="mb-4 space-y-0.5 rounded-lg border border-border-subtle bg-surface-secondary px-3 py-2.5 text-center" data-slot="auth-game-context">
      <p className="text-sm font-semibold text-text-primary">{matchup}</p>
      <p className="text-xs text-text-secondary">{action === "create" ? "Create your account to make your pick on this game." : "Log in to make your pick on this game."}</p>
    </div>
  );
}
