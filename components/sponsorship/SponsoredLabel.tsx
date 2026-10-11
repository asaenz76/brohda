"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicSponsorship } from "@/lib/sponsorship/types";

function SponsorIdentity({ logo, name }: { logo: React.ReactNode; name: string }) {
  return (
    <>
      {logo}
      <span className="font-medium text-text-secondary">{name}</span>
    </>
  );
}

/**
 * The restrained sponsor line of a Game Post: "Sponsored · Presented by <logo> Name", plus the sponsor's approved short call to action when there is
 * one. Small, one line (it wraps on narrow screens), never above the matchup, never touching the Pick controls. "Sponsored" is real, readable text — the
 * logo is a decoration beside the name, not the only identification.
 *
 * The sponsor identity (logo + name) is ONE link whenever the sponsorship has an approved destination (its own link, or the Sponsor profile website frozen at approval); with none it is
 * plain text and nothing is clickable. The call to action shows only when there is a link to go to. Both use the same first-party click path.
 *
 * Impressions (members only): the line must be at least half visible for a full second — see app/api/sponsorship/impression/route.ts for the exact
 * definition. A re-render or re-scroll cannot double count (one report per mount, and one stored row per member per day).
 */
export function SponsoredLabel({ sponsorship, trackImpression }: { sponsorship: PublicSponsorship; trackImpression: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const reported = useRef(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const logoRef = useRef<HTMLImageElement>(null);
  // A server-rendered logo can fail before React attaches onError; check once hydrated so a broken image never shows.
  useEffect(() => {
    const img = logoRef.current;
    if (img && img.complete && img.naturalWidth === 0) setLogoFailed(true);
  }, [sponsorship.logoUrl]);

  useEffect(() => {
    const el = ref.current;
    if (!trackImpression || !el || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5);
        if (visible && !reported.current && !timer) {
          timer = setTimeout(() => {
            reported.current = true;
            void fetch("/api/sponsorship/impression", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sponsorshipId: sponsorship.id }), keepalive: true }).catch(() => {});
          }, 1000);
        } else if (!visible && timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [trackImpression, sponsorship.id]);

  const logo =
    sponsorship.logoUrl && !logoFailed ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        ref={logoRef}
        src={sponsorship.logoUrl}
        alt=""
        data-slot="sponsor-logo"
        loading="lazy"
        onError={() => setLogoFailed(true)}
        className="mr-1 inline-block size-4 shrink-0 rounded-[3px] bg-white/90 object-contain p-px align-text-bottom"
      />
    ) : null;

  return (
    // One flowing line of text (it wraps at word boundaries on narrow screens instead of breaking into separate rows).
    <p ref={ref as React.RefObject<HTMLParagraphElement>} data-slot="sponsored-label" className="text-xs leading-5 text-text-muted">
      <span className="font-medium text-text-secondary">Sponsored</span>
      <span aria-hidden="true"> · </span>
      <span>Presented by </span>
      {sponsorship.hasLink ? (
        // ONE link around the sponsor identity (logo + name): a single anchor means a single click event, and its accessible name says where it goes — not just the logo's alt text.
        // It uses the same first-party click path as the call to action, so every outbound click is measured once, in one place.
        <a
          href={`/sponsorship/click/${sponsorship.id}`}
          target="_blank"
          rel="sponsored noopener noreferrer"
          aria-label={`Visit ${sponsorship.presentedBy} (opens in a new tab)`}
          data-slot="sponsor-link"
          className="rounded-sm underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <SponsorIdentity logo={logo} name={sponsorship.presentedBy} />
        </a>
      ) : (
        <SponsorIdentity logo={logo} name={sponsorship.presentedBy} />
      )}
      {sponsorship.ctaText && sponsorship.hasLink && (
        <>
          <span aria-hidden="true"> · </span>
          <a
            href={`/sponsorship/click/${sponsorship.id}`}
            target="_blank"
            rel="sponsored noopener noreferrer"
            aria-label={`${sponsorship.ctaText} — opens ${sponsorship.presentedBy}'s website in a new tab`}
            data-slot="sponsor-cta"
            className="font-medium text-accent-primary underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {sponsorship.ctaText}
          </a>
        </>
      )}
    </p>
  );
}
