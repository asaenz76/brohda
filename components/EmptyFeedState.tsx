import type { LucideIcon } from "lucide-react";
import { Rss } from "lucide-react";

export function EmptyFeedState({
  icon: Icon = Rss,
  title,
  description,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-subtle px-6 py-16 text-center">
      <Icon className="size-8 text-text-muted" aria-hidden="true" />
      <p className="text-base font-semibold text-text-primary">{title}</p>
      <p className="max-w-xs text-sm text-text-secondary">{description}</p>
    </div>
  );
}
