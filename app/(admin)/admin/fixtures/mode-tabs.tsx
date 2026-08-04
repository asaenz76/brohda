"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export type FixturesMode = "date" | "competition" | "fixture-id";

const TABS: Array<{ mode: FixturesMode; label: string }> = [
  { mode: "date", label: "By date" },
  { mode: "competition", label: "By competition" },
  { mode: "fixture-id", label: "By fixture ID" },
];

export function ModeTabs({ mode }: { mode: FixturesMode }) {
  const router = useRouter();

  return (
    <div className="flex gap-1 border-b border-border-subtle">
      {TABS.map((tab) => (
        <button
          key={tab.mode}
          type="button"
          onClick={() => router.push(`/admin/fixtures?mode=${tab.mode}`)}
          className={cn(
            "border-b-2 px-3 py-2 text-sm font-medium",
            mode === tab.mode ? "border-accent-primary text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
