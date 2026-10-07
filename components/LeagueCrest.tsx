"use client";

import { useEffect, useRef, useState } from "react";
import type { LeagueIdentity } from "@/lib/sports-data/league-crest";

/**
 * The league line of a Game card: a small crest beside the league's name. Context, not the hero — it never competes with the matchup or the
 * Pick. The crest keeps its own aspect ratio (`object-contain`, never stretched or cropped) on a small light tile so a dark mark stays legible in
 * dark mode. A missing crest, or one that fails to load, collapses to the league name as plain text — never a broken-image icon, never another
 * sport's icon. The name is always present as text, so the image itself is decorative (`alt=""`).
 */
export function LeagueCrest({ league }: { league: LeagueIdentity }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // The server-rendered <img> can fail to load before React attaches onError (the event is missed), so also check once hydrated.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [league.crestUrl]);
  if (!league.name && (!league.crestUrl || failed)) return null;
  return (
    <span data-slot="league-identity" className="inline-flex items-center gap-1.5 align-middle font-medium text-text-secondary">
      {league.crestUrl && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={league.crestUrl}
          alt=""
          data-slot="league-crest"
          loading="lazy"
          onError={() => setFailed(true)}
          className="size-4 shrink-0 rounded-[3px] bg-white/90 object-contain p-px"
        />
      )}
      {league.name && <span>{league.name}</span>}
    </span>
  );
}
