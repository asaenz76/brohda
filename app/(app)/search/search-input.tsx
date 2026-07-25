"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search as SearchIcon } from "lucide-react";

// Debounced, URL-driven like feed-filters.tsx/leaderboard-filters.tsx —
// but text input needs a debounce where those dropdowns don't, since
// every keystroke would otherwise push a navigation.
export function SearchInput({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = value.trim();
      if (trimmed) {
        params.set("q", trimmed);
      } else {
        params.delete("q");
      }
      const query = params.toString();
      router.push(query ? `/search?${query}` : "/search");
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-debounce on typing
  }, [value]);

  return (
    <div className="relative">
      <SearchIcon
        className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search players, fixtures, or markets"
        aria-label="Search players, fixtures, or markets"
        className="w-full rounded-full border border-border-subtle bg-surface-secondary py-2 pl-9 pr-3 text-sm text-text-primary outline-none placeholder:text-text-muted"
      />
    </div>
  );
}
