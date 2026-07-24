"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "predictions", label: "Predictions" },
  { id: "edit", label: "Edit profile" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export function ProfileTabs({
  predictions,
  edit,
}: {
  predictions: React.ReactNode;
  edit: React.ReactNode;
}) {
  // Read once on mount — lets the profile-completion redirect
  // (?tab=edit&required=1) land the user directly on Edit profile.
  // Deliberately not kept in sync afterward: switching tabs by clicking
  // stays purely client-state, same as before.
  const searchParams = useSearchParams();
  const initialTab = isTabId(searchParams.get("tab")) ? (searchParams.get("tab") as TabId) : "predictions";
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  return (
    <div className="space-y-4">
      <div className="flex gap-4 border-b border-border-subtle">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            aria-current={activeTab === id ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-1 pb-2 text-sm font-semibold transition-colors",
              activeTab === id
                ? "border-accent-primary text-text-primary"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {label}
          </button>
        ))}
        {/* Real pages, not inline tab content — plain nav links styled
            to match, not stateful tabs. */}
        <Link
          href="/analytics"
          className="-mb-px border-b-2 border-transparent px-1 pb-2 text-sm font-semibold text-text-muted transition-colors hover:text-text-secondary"
        >
          Analytics
        </Link>
        <Link
          href="/rules"
          className="-mb-px border-b-2 border-transparent px-1 pb-2 text-sm font-semibold text-text-muted transition-colors hover:text-text-secondary"
        >
          Rules
        </Link>
      </div>

      <div className={activeTab === "predictions" ? "block" : "hidden"}>{predictions}</div>
      <div className={activeTab === "edit" ? "block" : "hidden"}>{edit}</div>
    </div>
  );
}
