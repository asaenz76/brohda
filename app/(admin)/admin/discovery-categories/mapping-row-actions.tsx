"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteMappingAction, setMappingEnabledAction } from "@/lib/actions/discovery-categories";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export function MappingRowActions({ mappingId, enabled }: { mappingId: string; enabled: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle(next: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await setMappingEnabledAction(mappingId, next);
      if (!result.success) return setError(result.error);
      router.refresh();
    });
  }

  function remove() {
    if (!confirm("Remove this mapping?")) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteMappingAction(mappingId);
      if (!result.success) return setError(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-3">
      <Switch checked={enabled} onCheckedChange={toggle} disabled={isPending} aria-label={enabled ? "Disable mapping" : "Enable mapping"} />
      <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={remove}>
        Remove
      </Button>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
