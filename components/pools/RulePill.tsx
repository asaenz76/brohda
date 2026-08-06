import { Badge } from "@/components/ui/badge";

// X.5.5: always visible, never hidden in a tooltip, plain language.
// whitespace-normal overrides Badge's default nowrap — a grading-rule
// description runs much longer than a typical short badge tag, and at
// large accessibility text sizes an unwrappable pill pushes the card
// wider than the viewport instead of wrapping onto a second line.
export function RulePill({ label }: { label: string }) {
  return <Badge className="whitespace-normal text-left">{label}</Badge>;
}
