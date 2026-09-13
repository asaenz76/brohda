"use client";

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface PoolChoiceButtonProps {
  label: string;
  logoUrl: string | null;
  isCurrentUserChoice: boolean;
  disabled: boolean;
  onSelect: () => void;
  // True for the first option in the list only — gives that button a
  // light accent tint by default (matching the Common Ninja reference's
  // "one side colored, one side not" liveliness) without touching the
  // math or implying that option is favored/correct: it's purely
  // positional, the same "first option = accent-primary" convention
  // CommunitySplit already uses for its leading bar segment, extended
  // here for visual consistency between the two. Deliberately a light
  // tint, not a full solid fill — the full solid fill is reserved for
  // "this is your actual selection" so the two states can never be
  // confused with each other.
  isFirst?: boolean;
}

// Info/action separation: this button carries the choice only — no
// percentage or estimated payout embedded here. That data now lives in
// CommunitySplit (percentage) and the post-selection entry flow (estimated
// return). Sized as a large poll answer (56–64px tall, bold label), not a
// form row — the prediction is the card's primary action, so it should
// look like the biggest thing on the card. Bolder 2px borders + a hard
// offset shadow give it the graphic "pop" of the reference widget — the
// shadow is drawn from text-primary (near-black in light mode, near-white
// in dark) rather than literal black, so it stays high-contrast in both
// themes instead of vanishing against the dark one.
export function PoolChoiceButton({
  label,
  logoUrl,
  isCurrentUserChoice,
  disabled,
  onSelect,
  isFirst = false,
}: PoolChoiceButtonProps) {
  return (
    <Button
      type="button"
      variant={isCurrentUserChoice ? "default" : "outline"}
      fullWidth
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={isCurrentUserChoice}
      className={cn(
        // Border color is uniform (text-primary) across every state,
        // same as the reference — only the fill changes to carry meaning
        // (accent tint for the default-leading option, solid fill for
        // your actual selection, plain surface otherwise).
        "h-14 justify-center gap-2 rounded-2xl border-2 border-text-primary px-4 text-base font-bold shadow-[3px_3px_0_0_var(--text-primary)] sm:h-16 sm:text-lg",
        !isCurrentUserChoice && isFirst && "bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/15",
      )}
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-7 shrink-0 rounded-full object-contain" />
      ) : null}
      <span className="truncate">{label}</span>
      {isCurrentUserChoice && <Check className="size-5 shrink-0" aria-hidden="true" />}
    </Button>
  );
}
