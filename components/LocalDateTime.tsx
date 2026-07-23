"use client";

import { useEffect, useState } from "react";

interface LocalDateTimeProps {
  /** ISO 8601 instant — always an absolute moment (e.g. a fixture's
   *  scheduled_start_utc, or a pool's locks_at), never a "local time" string. */
  iso: string;
  options: Intl.DateTimeFormatOptions;
  className?: string;
}

/**
 * Renders an absolute instant in the *viewer's own* local timezone — a
 * Costa-Rica-based admin and a player watching from Tokyo should each read
 * the same fixture's kickoff in their own wall-clock time, not the
 * server's. The only place a browser's real timezone is knowable is after
 * mount, so the first render (both the server's HTML and the client's
 * initial hydration pass) uses a fixed UTC/en-US format — deterministic on
 * both sides, so React never flags a hydration mismatch — then a
 * useEffect swaps in the viewer's actual local zone once mounted.
 */
export function LocalDateTime({ iso, options, className }: LocalDateTimeProps) {
  const [formatted, setFormatted] = useState(() =>
    new Date(iso).toLocaleString("en-US", { ...options, timeZone: "UTC" }),
  );

  useEffect(() => {
    // Deliberate exception: the corrected value depends on the browser's
    // real timezone, which is only knowable once mounted (an external-
    // system read, not a value derivable from props/state during render) —
    // this is the standard SSR/client hydration-safe-formatting pattern
    // (the same shape next-themes uses for theme detection), not a "you
    // might not need an effect" case.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFormatted(new Date(iso).toLocaleString("en-US", options));
    // `options` is a fresh object literal on every caller render — keying
    // the effect on `iso` (the value that actually identifies "which
    // instant") avoids re-running on every unrelated parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iso]);

  return <span className={className}>{formatted}</span>;
}
