import { Badge } from "@/components/ui/badge";

// X.5.5: always visible, never hidden in a tooltip, plain language.
export function RulePill({ label }: { label: string }) {
  return <Badge>{label}</Badge>;
}
