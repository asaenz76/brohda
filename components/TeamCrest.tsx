// Stage 4B remediation — small inline team crest for Brohda 2.0's Post/
// feed surfaces (not to be confused with components/pools/TeamIdentity.tsx,
// the legacy Pools product's larger centered crest-first layout, which also
// carries team-follow logic that doesn't apply here). Plain <img>, matching
// that same established convention, to avoid maintaining a remote-domain
// allowlist for next/image across every possible sports-data provider.
// Renders nothing (not a broken-image icon, not a placeholder circle) when
// no logo URL was supplied — this is a compact inline context, not the
// Pools card's big visual anchor, so an empty gray circle would be noise.
export function TeamCrest({
  logoUrl,
  teamName,
  className,
}: {
  logoUrl: string | null;
  teamName: string;
  /** Phase B addition — overrides the default `size-5`; every other class stays fixed. Additive, existing call sites (no className) are unaffected. */
  className?: string;
}) {
  if (!logoUrl) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logoUrl} alt="" title={teamName} className={className ? `${className} shrink-0 rounded-full object-contain` : "size-5 shrink-0 rounded-full object-contain"} />;
}
