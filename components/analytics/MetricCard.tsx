import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: string;
  helpText?: string;
  // Caller decides tone — a rising loss count is "up" numerically but
  // negative in tone, so the direction/favorability judgment can't be
  // inferred generically from the sign of the delta.
  delta?: { text: string; tone: "positive" | "negative" | "neutral" } | null;
  emptyMessage?: string;
}

const TONE_CLASSES = {
  positive: "text-credit",
  negative: "text-debit",
  neutral: "text-text-muted",
} as const;

export function MetricCard({ label, value, helpText, delta, emptyMessage }: MetricCardProps) {
  return (
    <Card size="sm">
      <CardContent className="space-y-1">
        <p className="text-xs font-medium tracking-wide text-text-muted uppercase">{label}</p>
        {emptyMessage ? (
          <p className="text-sm text-text-muted">{emptyMessage}</p>
        ) : (
          <>
            <p className="font-heading text-2xl font-semibold text-text-primary">{value}</p>
            {delta && <p className={cn("text-xs font-medium", TONE_CLASSES[delta.tone])}>{delta.text}</p>}
          </>
        )}
        {helpText && <p className="text-xs text-text-muted">{helpText}</p>}
      </CardContent>
    </Card>
  );
}
