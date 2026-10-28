import { getAuthGameIntent } from "@/lib/auth/game-context";

/**
 * M7 — a visitor who tapped a side on a Game and was sent to sign up or log in should still see WHY: the Game they came for. M8 also keeps the SIDE they tapped in view, worded as intent ("You chose X") — nothing is saved before they confirm
 * on the Game afterwards, and the copy never says otherwise. A visitor who came without a side gets the Game alone. Short on purpose: it reassures, it does not explain.
 */
export async function AuthGameContext({ next, action }: { next: string | null; action: "create" | "login" }) {
  const intent = await getAuthGameIntent(next);
  if (!intent) return null;
  const then = action === "create" ? "Create your account, then confirm your pick." : "Log in, then confirm your pick.";
  const fallback = action === "create" ? "Create your account to make your pick on this game." : "Log in to make your pick on this game.";
  return (
    <div className="mb-4 space-y-0.5 rounded-lg border border-border-subtle bg-surface-secondary px-3 py-2.5 text-center" data-slot="auth-game-context">
      <p className="text-sm font-semibold text-text-primary">{intent.matchup}</p>
      {intent.choiceLabel ? (
        <>
          <p className="text-sm text-text-primary" data-slot="auth-game-choice">
            You chose {intent.choiceLabel}.
          </p>
          <p className="text-xs text-text-muted">{then}</p>
        </>
      ) : (
        <p className="text-xs text-text-muted">{fallback}</p>
      )}
    </div>
  );
}
