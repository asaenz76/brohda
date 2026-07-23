"use client";

import { useRouter, useSearchParams } from "next/navigation";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "all", label: "All" },
];

export function UsersFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateStatus(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "active") {
      params.delete("status");
    } else {
      params.set("status", value);
    }
    // A stale page number from the previous filter's result set can point
    // past the end of the new one, so any status change starts back at 1.
    params.delete("page");
    const query = params.toString();
    router.push(query ? `/admin/users?${query}` : "/admin/users");
  }

  return (
    <select
      aria-label="Filter by status"
      value={searchParams.get("status") ?? "active"}
      onChange={(e) => updateStatus(e.target.value)}
      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
    >
      {STATUS_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
