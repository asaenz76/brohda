"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const ALL_TABS = [
  { id: "predictions", label: "Predictions" },
  // Milestone 3 — deliberately distinct label/id from "predictions" above
  // (which is the legacy pool-entries tab): the two domains must never be
  // visually or structurally conflated. See market-predictions-tab.tsx.
  { id: "markets", label: "Market Predictions" },
  { id: "following", label: "Teams & Leagues" },
  { id: "edit", label: "Edit profile" },
] as const;

type TabId = (typeof ALL_TABS)[number]["id"];

export function ProfileTabs({
  predictions,
  markets,
  following,
  edit,
}: {
  predictions: React.ReactNode;
  /**
   * Stage 4A remediation (Stage 4 audit §18 — "profile Market Predictions
   * tab appearing while social prediction is disabled"): `null` hides the
   * tab entirely (its content is also never rendered by the caller, see
   * app/(app)/profile/page.tsx), matching the same
   * social_prediction_enabled-or-admin gate the nav bar itself uses.
   */
  markets: React.ReactNode | null;
  following: React.ReactNode;
  edit: React.ReactNode;
}) {
  const TABS = ALL_TABS.filter((tab) => tab.id !== "markets" || markets !== null);
  function isTabId(value: string | null): value is TabId {
    return TABS.some((tab) => tab.id === value);
  }

  // Read once on mount — lets a deep link (?tab=edit) land the user
  // directly on Edit profile. Deliberately not kept in sync afterward:
  // switching tabs by clicking stays purely client-state, same as before.
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
      {markets !== null && <div className={activeTab === "markets" ? "block" : "hidden"}>{markets}</div>}
      <div className={activeTab === "following" ? "block" : "hidden"}>{following}</div>
      <div className={activeTab === "edit" ? "block" : "hidden"}>{edit}</div>
    </div>
  );
}
