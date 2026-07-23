"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-subtle px-6 py-16 text-center">
      <AlertTriangle className="size-8 text-text-muted" aria-hidden="true" />
      <p className="text-base font-semibold text-text-primary">Something went wrong</p>
      <p className="max-w-xs text-sm text-text-secondary">
        This admin page hit an unexpected error. You can try again, or check the audit log for
        recent activity.
      </p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
