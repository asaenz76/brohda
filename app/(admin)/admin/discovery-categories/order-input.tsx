"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/actions/discovery-categories";

/** A plain explicit order number field, committed on blur — the "simple explicit order number" roadmap STEP 6 says is acceptable in place of drag-and-drop. */
export function OrderInput({
  categoryId,
  value,
  action,
}: {
  categoryId: string;
  value: number;
  action: (categoryId: string, displayOrder: number) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function commit() {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed === value) return;
    setError(null);
    startTransition(async () => {
      const result = await action(categoryId, parsed);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="w-16 space-y-1">
      <Input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        disabled={isPending}
        aria-label="Display order"
        className="h-8 text-sm"
      />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
