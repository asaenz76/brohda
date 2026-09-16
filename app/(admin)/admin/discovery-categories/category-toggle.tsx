"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCategoryEnabledAction } from "@/lib/actions/discovery-categories";
import { Switch } from "@/components/ui/switch";

/** Enable/disable toggle — the taxonomy edit this milestone's configurability demonstration exercises directly (roadmap STEP 26). */
export function CategoryToggle({ categoryId, enabled }: { categoryId: string; enabled: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setCategoryEnabledAction(categoryId, next);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Switch checked={enabled} onCheckedChange={handleChange} disabled={isPending} aria-label={enabled ? "Disable category" : "Enable category"} />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
