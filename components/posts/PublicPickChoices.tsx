import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The logged-out version of a Game Post's Pick control: same labels, same
 * layout and same visual weight as PredictionActions, so a visitor sees the
 * real mechanic — but each choice is a plain link to sign-up, never a
 * mutation. A visitor's intent click leads to creating an account; nothing is
 * recorded for an anonymous visitor.
 */
export function PublicPickChoices({ yesLabel, noLabel }: { yesLabel: string; noLabel: string }) {
  return (
    <div className="space-y-2" data-testid="public-pick-choices">
      <p className="text-sm font-semibold text-text-primary">Make your prediction</p>
      {/* Stacked full-width below sm, inline from sm — same overflow guard as the member control. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
        {[yesLabel, noLabel].map((label) => (
          <Link
            key={label}
            href="/register"
            aria-label={`Pick: ${label} (create an account to make your pick)`}
            className={cn(buttonVariants({ variant: "outline", size: "lg" }), "w-full sm:w-auto")}
          >
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}
