"use client";

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PoolChoiceButtonProps {
  label: string;
  logoUrl: string | null;
  isCurrentUserChoice: boolean;
  disabled: boolean;
  onSelect: () => void;
}

// Info/action separation: this button carries the choice only — no
// percentage or estimated payout embedded here. That data now lives in
// CommunitySplit (percentage) and the post-selection entry flow (estimated
// return). Selected state is a solid accent fill (shared Button `default`
// variant); unselected is outline — matches the approved mockup's visual
// language. Sized as a large poll answer (56–64px tall, bold label),
// not a form row — the prediction is the card's primary action, so it
// should look like the biggest thing on the card.
export function PoolChoiceButton({ label, logoUrl, isCurrentUserChoice, disabled, onSelect }: PoolChoiceButtonProps) {
  return (
    <Button
      type="button"
      variant={isCurrentUserChoice ? "default" : "outline"}
      fullWidth
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={isCurrentUserChoice}
      className="h-14 justify-center gap-2 rounded-2xl px-4 text-base font-bold sm:h-16 sm:text-lg"
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
