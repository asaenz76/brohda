import type { ReactNode } from "react";

export function AnalyticsPageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-heading text-xl font-semibold text-text-primary">{title}</h1>
        {description && <p className="text-sm text-text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
