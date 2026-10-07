import { cn } from "@/lib/utils";

// A sport has no crest, so it gets a mark of its own: one simple outline icon per sport, drawn in the same 24px stroke style as the app's other
// icons (lucide) and coloured by the surrounding text colour, so it works in light and dark themes without a second asset. Keyed by the sport key
// (fixtures.sport / communities.sport_key — the keys in lib/sports-data/sport-registry.ts); a sport without artwork falls back to a neutral mark,
// never to nothing and never to another sport's icon. Decorative: the sport's name is always next to it, so it is hidden from assistive technology.
const ICONS: Record<string, React.ReactNode> = {
  basketball: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2v20" />
      <path d="M2 12h20" />
      <path d="M5.3 4.7a14 14 0 0 1 0 14.6" />
      <path d="M18.7 4.7a14 14 0 0 0 0 14.6" />
    </>
  ),
  american_football: (
    <g transform="rotate(-45 12 12)">
      <ellipse cx="12" cy="12" rx="10.5" ry="6.5" />
      <path d="M8 12h8" />
      <path d="M10 10.3v3.4M12 10.3v3.4M14 10.3v3.4" />
      <path d="M5.4 8.3q-1.1 3.7 0 7.4" />
      <path d="M18.6 8.3q1.1 3.7 0 7.4" />
    </g>
  ),
  hockey: (
    <>
      <path d="M4 2.5l9.6 16H21" />
      <ellipse cx="7" cy="18.3" rx="3.2" ry="1.3" />
      <path d="M3.8 18.3v2c0 .8 1.4 1.4 3.2 1.4s3.2-.6 3.2-1.4v-2" />
    </>
  ),
  baseball: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M5.6 5.6c2.6 2.6 2.6 10.2 0 12.8" />
      <path d="M18.4 5.6c-2.6 2.6-2.6 10.2 0 12.8" />
    </>
  ),
};

const FALLBACK = (
  <>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="3.5" />
  </>
);

export function hasSportIcon(sport: string | null | undefined): boolean {
  return Boolean(sport && ICONS[sport]);
}

export function SportIcon({ sport, className }: { sport: string | null | undefined; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-testid="sport-icon"
      data-sport={sport ?? "unknown"}
      className={cn("size-full", className)}
    >
      {(sport && ICONS[sport]) || FALLBACK}
    </svg>
  );
}
